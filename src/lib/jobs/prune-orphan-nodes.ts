/**
 * Deterministic pruning for legacy orphan entity nodes.
 *
 * The job first repairs source integrity by tombstoning leaf blob-backed
 * sources whose object is gone from storage, which retracts their claims and
 * source links through the lifecycle boundary. A missing parent blob does not
 * prove that child content is missing, so parents with any owned descendants
 * are preserved. Prunable orphan nodes then have no claims as
 * subject/object/speaker and no aliases. Source links alone are not graph
 * evidence. These rows are not memory: they cannot be safely re-linked. The
 * job defaults to entity/task node types so generated/system nodes such as
 * AssistantDream and Atlas are not swept accidentally.
 *
 * Common aliases: prune orphan nodes, orphan node cleanup, evidence-free nodes.
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  memoryPartitions,
  nodeMetadata,
  nodes,
  sources,
  users,
} from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import {
  assertPartitionReadAllowed,
  lockSourceParentAttachmentGates,
  PartitionAccessError,
  partitionAccessCondition,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import {
  pruneOrphanNodesRequestSchema,
  type PruneMissingBlobSource,
  type PruneOrphanNode,
  type PruneOrphanNodesRequest,
  type PruneOrphanNodesResponse,
} from "~/lib/schemas/prune-orphan-nodes";
import {
  applySourceLifecycleCommand,
  SourceLifecycleError,
} from "~/lib/source-lifecycle";
import {
  sourceMetadataSchema,
  sourceService,
  type SourceBlobStore,
} from "~/lib/sources";
import { resolveWorkspacePartitions } from "~/lib/workspace-partitions";
import type { NodeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

type PruneDatabase = DrizzleDB;

function partitionScopeCondition(
  column: SQLWrapper,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): SQL<unknown> {
  if (partitionKeys.length === 1) {
    const [partitionKey] = partitionKeys;
    return partitionKey === undefined
      ? isNull(column)
      : eq(column, partitionKey);
  }
  const activePartitionKeys = partitionKeys.filter(
    (partitionKey): partitionKey is ContextPartitionKey =>
      partitionKey !== undefined,
  );
  const conditions: SQL<unknown>[] = [];
  if (activePartitionKeys.length > 0) {
    conditions.push(
      and(
        inArray(column, activePartitionKeys),
        partitionAccessCondition(column, userId, undefined, "workspace"),
      )!,
    );
  }
  if (partitionKeys.some((partitionKey) => partitionKey === undefined)) {
    conditions.push(
      partitionAccessCondition(column, userId, undefined, "workspace"),
    );
  }
  if (conditions.length === 0) return sql`false`;
  return conditions.length === 1 ? conditions[0]! : or(...conditions)!;
}

async function lockUserForPrune(
  db: PruneDatabase,
  userId: string,
): Promise<void> {
  await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
}

async function assertActivePartitionOwnership(
  db: PruneDatabase,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): Promise<void> {
  const requiredKeys = partitionKeys.filter(
    (partitionKey): partitionKey is ContextPartitionKey =>
      partitionKey !== undefined,
  );
  if (requiredKeys.length === 0) return;
  const rows = await db
    .select({ partitionKey: memoryPartitions.partitionKey })
    .from(memoryPartitions)
    .where(
      and(
        eq(memoryPartitions.userId, userId),
        eq(memoryPartitions.status, "active"),
        inArray(memoryPartitions.partitionKey, requiredKeys),
      ),
    );
  if (
    new Set(rows.map((row) => row.partitionKey)).size !== requiredKeys.length
  ) {
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      `Memory partition ownership changed while pruning for user ${userId}`,
    );
  }
}

const DEFAULT_PRUNABLE_NODE_TYPES = [
  "Person",
  "Organization",
  "Location",
  "Event",
  "Object",
  "Emotion",
  "Concept",
  "Media",
  "Feedback",
  "Idea",
  "Task",
] as const satisfies readonly NodeType[];

interface OrphanCandidateRow {
  id: TypeId<"node">;
  nodeType: NodeType;
  label: string | null;
  createdAt: Date;
}

interface MissingBlobSourceCandidateRow {
  id: TypeId<"source">;
  type: string;
  externalId: string;
  partitionKey: ContextPartitionKey | null;
  version: number;
  createdAt: Date;
  metadata: unknown;
}

interface MissingBlobSourceScan {
  scannedCount: number;
  hasMore: boolean;
  candidates: MissingBlobSourceCandidateRow[];
  existingBlobSourceIds: ReadonlySet<TypeId<"source">>;
}

function sourceExpectsBlobCondition(
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): ReturnType<typeof and> {
  return and(
    eq(sources.userId, userId),
    partitionScopeCondition(sources.partitionKey, userId, partitionKeys),
    isNull(sources.deletedAt),
    or(isNotNull(sources.contentLength), isNotNull(sources.contentType)),
  );
}

function sourceHasStoredText(metadata: unknown): boolean {
  const parsed = sourceMetadataSchema.parse(metadata ?? {});
  return (
    parsed.rawContent !== undefined || parsed.convertedMarkdown !== undefined
  );
}

function orphanEvidenceFreeCondition(
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): ReturnType<typeof and> {
  return and(
    sql`NOT EXISTS (
      SELECT 1 FROM ${claims}
      WHERE ${claims.userId} = ${userId}
        AND ${partitionScopeCondition(claims.partitionKey, userId, partitionKeys)}
        AND (
          ${claims.subjectNodeId} = ${nodes.id}
          OR ${claims.objectNodeId} = ${nodes.id}
          OR ${claims.assertedByNodeId} = ${nodes.id}
        )
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${aliases}
      WHERE ${aliases.userId} = ${userId}
        AND ${partitionScopeCondition(aliases.partitionKey, userId, partitionKeys)}
        AND ${aliases.canonicalNodeId} = ${nodes.id}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${nodeMetadata} AS self_metadata
      WHERE self_metadata.node_id = ${nodes.id}
        AND self_metadata.additional_data->>'isUserSelf' = 'true'
    )`,
  );
}

async function findOrphanCandidates(
  db: PruneDatabase,
  params: {
    userId: string;
    cutoff: Date;
    limit: number;
    nodeTypes: readonly NodeType[];
    partitionKeys: readonly (ContextPartitionKey | undefined)[];
    nodeIds?: readonly TypeId<"node">[];
  },
): Promise<OrphanCandidateRow[]> {
  if (params.nodeTypes.length === 0) return [];

  return db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, params.userId),
        partitionScopeCondition(
          nodes.partitionKey,
          params.userId,
          params.partitionKeys,
        ),
        lt(nodes.createdAt, params.cutoff),
        inArray(nodes.nodeType, [...params.nodeTypes]),
        ...(params.nodeIds ? [inArray(nodes.id, [...params.nodeIds])] : []),
        orphanEvidenceFreeCondition(params.userId, params.partitionKeys),
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(params.limit);
}

async function lockSelectedOrphanEvidence(
  db: PruneDatabase,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
  nodeIds: readonly TypeId<"node">[],
): Promise<void> {
  if (nodeIds.length === 0) return;

  const lockedNodes = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.userId, userId),
        partitionScopeCondition(nodes.partitionKey, userId, partitionKeys),
        inArray(nodes.id, [...nodeIds]),
      ),
    )
    .orderBy(asc(nodes.id))
    .for("update");
  const lockedNodeIds = lockedNodes.map((node) => node.id);
  if (lockedNodeIds.length === 0) return;

  await db
    .select({ id: claims.id })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        partitionScopeCondition(claims.partitionKey, userId, partitionKeys),
        or(
          inArray(claims.subjectNodeId, lockedNodeIds),
          inArray(claims.objectNodeId, lockedNodeIds),
          inArray(claims.assertedByNodeId, lockedNodeIds),
        ),
      ),
    )
    .orderBy(asc(claims.id))
    .for("update");
  await db
    .select({ id: nodeMetadata.id })
    .from(nodeMetadata)
    .where(inArray(nodeMetadata.nodeId, lockedNodeIds))
    .orderBy(asc(nodeMetadata.id))
    .for("update");
  await db
    .select({ id: aliases.id })
    .from(aliases)
    .where(
      and(
        eq(aliases.userId, userId),
        partitionScopeCondition(aliases.partitionKey, userId, partitionKeys),
        inArray(aliases.canonicalNodeId, lockedNodeIds),
      ),
    )
    .orderBy(asc(aliases.id))
    .for("update");
}

async function scanMissingBlobSources(
  db: PruneDatabase,
  blobStore: SourceBlobStore,
  params: {
    userId: string;
    limit: number;
    partitionKeys: readonly (ContextPartitionKey | undefined)[];
  },
): Promise<MissingBlobSourceScan> {
  const sourceRowsPlusOne = await db
    .select({
      id: sources.id,
      type: sources.type,
      externalId: sources.externalId,
      partitionKey: sources.partitionKey,
      version: sources.version,
      createdAt: sources.createdAt,
      metadata: sources.metadata,
    })
    .from(sources)
    .where(sourceExpectsBlobCondition(params.userId, params.partitionKeys))
    .orderBy(asc(sources.createdAt), asc(sources.id))
    .limit(params.limit + 1);
  const sourceRows = sourceRowsPlusOne.slice(0, params.limit);

  if (sourceRows.length === 0) {
    return {
      scannedCount: 0,
      hasMore: false,
      candidates: [],
      existingBlobSourceIds: new Set(),
    };
  }

  const existingBlobSourceIds = await blobStore.listBlobSourceIds(
    params.userId,
  );

  return {
    scannedCount: sourceRows.length,
    hasMore: sourceRowsPlusOne.length > params.limit,
    candidates: sourceRows.filter(
      (row) =>
        !sourceHasStoredText(row.metadata) &&
        !existingBlobSourceIds.has(row.id),
    ),
    existingBlobSourceIds,
  };
}

async function tombstoneMissingBlobSources(
  db: DrizzleDB,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
  candidates: readonly MissingBlobSourceCandidateRow[],
  existingBlobSourceIds: ReadonlySet<TypeId<"source">>,
): Promise<number> {
  if (candidates.length === 0) return 0;

  let deletedCount = 0;
  for (const candidate of candidates) {
    // Coordinate descendant attachment with lifecycle tree discovery before
    // checking whether this candidate is a leaf. A missing parent blob does
    // not justify erasing any child that was outside the scan budget.
    await lockSourceParentAttachmentGates(db, [
      { userId, sourceId: candidate.id },
    ]);
    const [source] = await db
      .select({
        id: sources.id,
        metadata: sources.metadata,
        partitionKey: sources.partitionKey,
        version: sources.version,
        deletedAt: sources.deletedAt,
        contentType: sources.contentType,
        contentLength: sources.contentLength,
      })
      .from(sources)
      .where(and(eq(sources.userId, userId), eq(sources.id, candidate.id)))
      .for("update")
      .limit(1);
    if (!source) {
      throw new SourceLifecycleError(
        "SOURCE_NOT_FOUND",
        `Source ${candidate.id} disappeared before its missing blob could be tombstoned`,
      );
    }
    if (source.partitionKey !== candidate.partitionKey) {
      throw new SourceLifecycleError(
        "SOURCE_PARTITION_CONFLICT",
        `Source ${candidate.id} changed partition before its missing blob could be tombstoned`,
        {
          sourcePartitionKey: source.partitionKey,
          sourceVersion: source.version,
        },
      );
    }
    if (source.version !== candidate.version) {
      throw new SourceLifecycleError(
        "SOURCE_VERSION_CONFLICT",
        `Source ${candidate.id} changed before its missing blob could be tombstoned`,
        {
          sourcePartitionKey: source.partitionKey,
          sourceVersion: source.version,
        },
      );
    }
    if (
      !partitionKeys.some(
        (partitionKey) => partitionKey === (source.partitionKey ?? undefined),
      )
    ) {
      throw new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        `Source ${candidate.id} is outside the requested memory partitions`,
      );
    }
    if (source.deletedAt !== null) {
      throw new SourceLifecycleError(
        "SOURCE_LIFECYCLE_STATE_CONFLICT",
        `Source ${candidate.id} is no longer live`,
      );
    }
    const [child] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(eq(sources.userId, userId), eq(sources.parentSource, candidate.id)),
      )
      .limit(1);
    if (child) continue;
    if (
      !sourceHasStoredText(source.metadata) &&
      (source.contentLength !== null || source.contentType !== null) &&
      !existingBlobSourceIds.has(source.id)
    ) {
      await applySourceLifecycleCommand(db, {
        userId,
        sourceId: source.id,
        expectedPartitionKey: source.partitionKey,
        expectedSourceVersion: source.version,
        commandId: randomUUID(),
        action: "tombstone",
      });
      deletedCount += 1;
    }
  }
  return deletedCount;
}

async function deleteStillOrphanNodes(
  db: PruneDatabase,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
  nodeIds: TypeId<"node">[],
): Promise<number> {
  if (nodeIds.length === 0) return 0;

  const deleted = await db
    .delete(nodes)
    .where(
      and(
        eq(nodes.userId, userId),
        partitionScopeCondition(nodes.partitionKey, userId, partitionKeys),
        inArray(nodes.id, nodeIds),
        // Re-check evidence at the destructive boundary in case another
        // ingestion linked a candidate between selection and deletion.
        orphanEvidenceFreeCondition(userId, partitionKeys),
      ),
    )
    .returning({ id: nodes.id });

  return deleted.length;
}

async function pruneOrphanNodesInScope(
  db: PruneDatabase,
  input: z.output<typeof pruneOrphanNodesRequestSchema>,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
  missingBlobSourceScan: MissingBlobSourceScan,
  deletedMissingBlobSourceCount: number,
): Promise<PruneOrphanNodesResponse> {
  const nodeTypes = input.nodeTypes ?? [...DEFAULT_PRUNABLE_NODE_TYPES];
  const cutoff = new Date(
    Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000,
  );
  const candidatesPlusOne = await findOrphanCandidates(db, {
    userId: input.userId,
    cutoff,
    limit: input.limit + 1,
    nodeTypes,
    partitionKeys,
  });
  const hasMore = candidatesPlusOne.length > input.limit;
  const candidates = candidatesPlusOne.slice(0, input.limit);

  let deletedCount = 0;
  if (!input.dryRun && candidates.length > 0) {
    const selectedIds = candidates.map((candidate) => candidate.id);
    await lockSelectedOrphanEvidence(
      db,
      input.userId,
      partitionKeys,
      selectedIds,
    );
    const freshCandidates = await findOrphanCandidates(db, {
      userId: input.userId,
      cutoff,
      limit: selectedIds.length,
      nodeTypes,
      partitionKeys,
      nodeIds: selectedIds,
    });
    // Do not refill from rows beyond the original global limit. Concurrent
    // evidence can only shrink the safe deletion set.
    deletedCount = await deleteStillOrphanNodes(
      db,
      input.userId,
      partitionKeys,
      freshCandidates.map((candidate) => candidate.id),
    );
  }

  if (
    missingBlobSourceScan.candidates.length > 0 ||
    deletedMissingBlobSourceCount > 0
  ) {
    logEvent("source.missing_blobs.pruned", {
      userId: input.userId,
      dryRun: input.dryRun,
      scannedCount: missingBlobSourceScan.scannedCount,
      candidateCount: missingBlobSourceScan.candidates.length,
      deletedCount: deletedMissingBlobSourceCount,
      hasMore: missingBlobSourceScan.hasMore,
    });
  }

  const sample: PruneOrphanNode[] = candidates
    .slice(0, input.sampleLimit)
    .map((candidate) => ({
      id: candidate.id,
      nodeType: candidate.nodeType,
      label: candidate.label,
      createdAt: candidate.createdAt,
    }));
  const missingBlobSourceSample: PruneMissingBlobSource[] =
    missingBlobSourceScan.candidates
      .slice(0, input.sampleLimit)
      .map((source) => ({
        id: source.id,
        type: source.type,
        externalId: source.externalId,
        createdAt: source.createdAt,
      }));

  return {
    dryRun: input.dryRun,
    sourceScanCount: missingBlobSourceScan.scannedCount,
    sourceScanHasMore: missingBlobSourceScan.hasMore,
    missingBlobSourceCandidateCount: missingBlobSourceScan.candidates.length,
    deletedMissingBlobSourceCount,
    candidateCount: candidates.length,
    deletedCount,
    hasMore,
    scannedNodeTypes: nodeTypes,
    missingBlobSources: missingBlobSourceSample,
    candidates: sample,
  };
}

async function prepareWorkspaceWrite(
  db: PruneDatabase,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): Promise<void> {
  for (const partitionKey of partitionKeys) {
    await preparePartitionWrite(db, userId, partitionKey);
  }
  await assertActivePartitionOwnership(db, userId, partitionKeys);
}

async function runOrphanPrune(
  db: DrizzleDB,
  input: z.output<typeof pruneOrphanNodesRequestSchema>,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
  blobStore: SourceBlobStore,
): Promise<PruneOrphanNodesResponse> {
  const missingBlobSourceScan = await scanMissingBlobSources(db, blobStore, {
    userId: input.userId,
    partitionKeys,
    limit: input.sourceScanLimit,
  });
  if (input.dryRun) {
    return pruneOrphanNodesInScope(
      db,
      input,
      partitionKeys,
      missingBlobSourceScan,
      0,
    );
  }

  // Refresh the storage snapshot immediately before entering PostgreSQL. No
  // blob-store I/O is allowed while the outer mutation transaction is open.
  const deletionBlobSourceIds =
    missingBlobSourceScan.candidates.length === 0
      ? missingBlobSourceScan.existingBlobSourceIds
      : await blobStore.listBlobSourceIds(input.userId);

  return db.transaction(async (tx) => {
    await lockUserForPrune(tx, input.userId);
    await prepareWorkspaceWrite(tx, input.userId, partitionKeys);
    const deletedMissingBlobSourceCount = await tombstoneMissingBlobSources(
      tx,
      input.userId,
      partitionKeys,
      missingBlobSourceScan.candidates,
      deletionBlobSourceIds,
    );
    return pruneOrphanNodesInScope(
      tx,
      input,
      partitionKeys,
      missingBlobSourceScan,
      deletedMissingBlobSourceCount,
    );
  });
}

/**
 * Prune evidence-free orphan nodes. Dry-run returns the candidate count and a
 * bounded sample; destructive mode deletes up to `limit` still-orphan rows.
 */
export async function pruneOrphanNodes(
  rawInput: PruneOrphanNodesRequest,
  dbOverride?: DrizzleDB,
  blobStore: SourceBlobStore = sourceService,
): Promise<PruneOrphanNodesResponse> {
  const input = pruneOrphanNodesRequestSchema.parse(rawInput);
  const db = dbOverride ?? (await useDatabase());
  const partitionKeys = [input.partitionKey];
  // Validate authority before storage I/O without mutating the partition
  // registry. The write preflight is repeated inside runOrphanPrune's outer
  // transaction so a later storage/lifecycle failure rolls it back too.
  await assertPartitionReadAllowed(db, input.userId, input.partitionKey);
  return runOrphanPrune(db, input, partitionKeys, blobStore);
}

/** Runs one deterministic workspace-wide orphan sweep under total limits. */
export async function pruneOrphanNodesWorkspace(
  rawInput: PruneOrphanNodesRequest,
  dbOverride?: DrizzleDB,
  blobStore: SourceBlobStore = sourceService,
): Promise<PruneOrphanNodesResponse> {
  const input = pruneOrphanNodesRequestSchema.parse(rawInput);
  const db = dbOverride ?? (await useDatabase());
  if (input.partitionKey !== undefined) {
    return pruneOrphanNodes(input, db, blobStore);
  }
  await assertPartitionReadAllowed(db, input.userId, undefined, "workspace");
  const partitionKeys = await resolveWorkspacePartitions(
    db,
    input.userId,
    undefined,
    "workspace",
  );
  if (input.dryRun) {
    return runOrphanPrune(db, input, partitionKeys, blobStore);
  }

  const missingBlobSourceScan = await scanMissingBlobSources(db, blobStore, {
    userId: input.userId,
    partitionKeys,
    limit: input.sourceScanLimit,
  });
  const deletionBlobSourceIds =
    missingBlobSourceScan.candidates.length === 0
      ? missingBlobSourceScan.existingBlobSourceIds
      : await blobStore.listBlobSourceIds(input.userId);

  return db.transaction(async (tx) => {
    await lockUserForPrune(tx, input.userId);
    const currentPartitionKeys = await resolveWorkspacePartitions(
      tx,
      input.userId,
      undefined,
      "workspace",
    );
    await prepareWorkspaceWrite(tx, input.userId, currentPartitionKeys);
    const deletedMissingBlobSourceCount = await tombstoneMissingBlobSources(
      tx,
      input.userId,
      currentPartitionKeys,
      missingBlobSourceScan.candidates,
      deletionBlobSourceIds,
    );
    return pruneOrphanNodesInScope(
      tx,
      input,
      currentPartitionKeys,
      missingBlobSourceScan,
      deletedMissingBlobSourceCount,
    );
  });
}
