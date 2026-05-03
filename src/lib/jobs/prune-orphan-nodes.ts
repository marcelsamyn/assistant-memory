/**
 * Deterministic pruning for legacy orphan entity nodes.
 *
 * The job first repairs source integrity by deleting blob-backed source rows
 * whose object is gone from storage. That cascades through claims/source_links
 * by FK, after which prunable orphan nodes are nodes with no claims as
 * subject/object/speaker, no source links, and no aliases. These rows are not
 * memory: they have no evidence and cannot be safely re-linked. The job
 * defaults to entity/task node types so generated/system nodes such as
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
} from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  nodeMetadata,
  nodes,
  sourceLinks,
  sources,
} from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import {
  pruneOrphanNodesRequestSchema,
  type PruneMissingBlobSource,
  type PruneOrphanNode,
  type PruneOrphanNodesRequest,
  type PruneOrphanNodesResponse,
} from "~/lib/schemas/prune-orphan-nodes";
import {
  sourceMetadataSchema,
  sourceService,
  type SourceBlobStore,
} from "~/lib/sources";
import type { NodeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

const DEFAULT_PRUNABLE_NODE_TYPES = [
  "Person",
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
  createdAt: Date;
  metadata: unknown;
}

interface MissingBlobSourceScan {
  scannedCount: number;
  hasMore: boolean;
  candidates: MissingBlobSourceCandidateRow[];
}

function sourceExpectsBlobCondition(userId: string): ReturnType<typeof and> {
  return and(
    eq(sources.userId, userId),
    isNull(sources.deletedAt),
    or(isNotNull(sources.contentLength), isNotNull(sources.contentType)),
  );
}

function sourceHasInlineRawContent(metadata: unknown): boolean {
  return sourceMetadataSchema.parse(metadata ?? {}).rawContent !== undefined;
}

function orphanEvidenceFreeCondition(userId: string): ReturnType<typeof and> {
  return and(
    sql`NOT EXISTS (
      SELECT 1 FROM ${claims}
      WHERE ${claims.userId} = ${userId}
        AND (
          ${claims.subjectNodeId} = ${nodes.id}
          OR ${claims.objectNodeId} = ${nodes.id}
          OR ${claims.assertedByNodeId} = ${nodes.id}
        )
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sourceLinks}
      WHERE ${sourceLinks.nodeId} = ${nodes.id}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${aliases}
      WHERE ${aliases.userId} = ${userId}
        AND ${aliases.canonicalNodeId} = ${nodes.id}
    )`,
  );
}

async function findOrphanCandidates(
  db: DrizzleDB,
  params: {
    userId: string;
    cutoff: Date;
    limit: number;
    nodeTypes: readonly NodeType[];
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
        lt(nodes.createdAt, params.cutoff),
        inArray(nodes.nodeType, [...params.nodeTypes]),
        orphanEvidenceFreeCondition(params.userId),
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(params.limit);
}

async function scanMissingBlobSources(
  db: DrizzleDB,
  blobStore: SourceBlobStore,
  params: {
    userId: string;
    limit: number;
  },
): Promise<MissingBlobSourceScan> {
  const sourceRowsPlusOne = await db
    .select({
      id: sources.id,
      type: sources.type,
      externalId: sources.externalId,
      createdAt: sources.createdAt,
      metadata: sources.metadata,
    })
    .from(sources)
    .where(sourceExpectsBlobCondition(params.userId))
    .orderBy(asc(sources.createdAt), asc(sources.id))
    .limit(params.limit + 1);
  const sourceRows = sourceRowsPlusOne.slice(0, params.limit);

  if (sourceRows.length === 0) {
    return { scannedCount: 0, hasMore: false, candidates: [] };
  }

  const existingBlobSourceIds = await blobStore.listBlobSourceIds(
    params.userId,
  );

  return {
    scannedCount: sourceRows.length,
    hasMore: sourceRowsPlusOne.length > params.limit,
    candidates: sourceRows.filter(
      (row) =>
        !sourceHasInlineRawContent(row.metadata) &&
        !existingBlobSourceIds.has(row.id),
    ),
  };
}

async function deleteStillMissingBlobSources(
  db: DrizzleDB,
  blobStore: SourceBlobStore,
  userId: string,
  sourceIds: TypeId<"source">[],
): Promise<number> {
  if (sourceIds.length === 0) return 0;

  const [sourceRows, existingBlobSourceIds] = await Promise.all([
    db
      .select({ id: sources.id, metadata: sources.metadata })
      .from(sources)
      .where(
        and(sourceExpectsBlobCondition(userId), inArray(sources.id, sourceIds)),
      ),
    blobStore.listBlobSourceIds(userId),
  ]);

  const stillMissingIds = sourceRows
    .filter(
      (row) =>
        !sourceHasInlineRawContent(row.metadata) &&
        !existingBlobSourceIds.has(row.id),
    )
    .map((row) => row.id);

  if (stillMissingIds.length === 0) return 0;

  const deleted = await db
    .delete(sources)
    .where(
      and(
        sourceExpectsBlobCondition(userId),
        inArray(sources.id, stillMissingIds),
      ),
    )
    .returning({ id: sources.id });

  return deleted.length;
}

async function deleteStillOrphanNodes(
  db: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<number> {
  if (nodeIds.length === 0) return 0;

  const deleted = await db
    .delete(nodes)
    .where(
      and(
        eq(nodes.userId, userId),
        inArray(nodes.id, nodeIds),
        // Re-check evidence at the destructive boundary in case another
        // ingestion linked a candidate between selection and deletion.
        orphanEvidenceFreeCondition(userId),
      ),
    )
    .returning({ id: nodes.id });

  return deleted.length;
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
  const nodeTypes = input.nodeTypes ?? [...DEFAULT_PRUNABLE_NODE_TYPES];
  const cutoff = new Date(
    Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000,
  );

  const missingBlobSourceScan = await scanMissingBlobSources(db, blobStore, {
    userId: input.userId,
    limit: input.sourceScanLimit,
  });
  const deletedMissingBlobSourceCount = input.dryRun
    ? 0
    : await deleteStillMissingBlobSources(
        db,
        blobStore,
        input.userId,
        missingBlobSourceScan.candidates.map((source) => source.id),
      );

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

  const candidatesPlusOne = await findOrphanCandidates(db, {
    userId: input.userId,
    cutoff,
    limit: input.limit + 1,
    nodeTypes,
  });
  const hasMore = candidatesPlusOne.length > input.limit;
  const candidates = candidatesPlusOne.slice(0, input.limit);

  const deletedCount = input.dryRun
    ? 0
    : await deleteStillOrphanNodes(
        db,
        input.userId,
        candidates.map((candidate) => candidate.id),
      );

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
