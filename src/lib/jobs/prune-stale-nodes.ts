/**
 * Deterministic staleness-based garbage collection for accreted graph cruft.
 *
 * Where {@link ./prune-orphan-nodes} only removes nodes with *zero* evidence,
 * this sweep scores every entity/task node and prunes the disposable tail:
 * old, weakly-connected, assistant-inferred-only, or superseded-dominated
 * nodes. The score is a transparent weighted sum of four components so a
 * consumer can preview exactly what would go and why before applying.
 *
 *   score = 0.40·staleness + 0.25·isolation + 0.20·weakProvenance + 0.15·decay
 *
 * Protected and never pruned: nodes active within `minIdleDays`, nodes with a
 * currently-open task status, the user's self-identity node(s), and (unless
 * `includeReference`) reference-scope nodes. Deletion cascades through claims,
 * source links, aliases, and embeddings by FK.
 *
 * Common aliases: prune stale nodes, memory garbage collection, graph GC,
 * weed old nodes, staleness sweep, low-quality node cleanup.
 */
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  memoryPartitions,
  nodeMetadata,
  nodes,
  sourceLinks,
  users,
  userProfiles,
} from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import {
  assertPartitionReadAllowed,
  PartitionAccessError,
  partitionAccessCondition,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import {
  pruneStaleNodesRequestSchema,
  type PruneStaleNodesRequest,
  type PruneStaleNodesResponse,
  type StaleNodeCandidate,
} from "~/lib/schemas/prune-stale-nodes";
import { userProfileMetadataSchema } from "~/lib/schemas/user-profile-metadata";
import { lockUserSelfIdentity } from "~/lib/user-self-identity";
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
  const conditions: SQL<unknown>[] = [];
  const activePartitionKeys = partitionKeys.filter(
    (partitionKey): partitionKey is ContextPartitionKey =>
      partitionKey !== undefined,
  );
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

const OPEN_TASK_STATUSES = ["pending", "in_progress"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// Score component weights. Sum to 1 so the score stays in [0, 1].
const W_STALENESS = 0.4;
const W_ISOLATION = 0.25;
const W_PROVENANCE = 0.2;
const W_DECAY = 0.15;

interface ScoredNodeRow {
  id: TypeId<"node">;
  nodeType: NodeType;
  label: string | null;
  createdAt: Date;
  lastClaimAt: Date | null;
  totalClaims: number;
  activeClaims: number;
  supersededClaims: number;
  groundedActiveClaims: number;
  activeReferenceClaims: number;
  activePersonalClaims: number;
  hasAlias: boolean;
  hasSourceLink: boolean;
}

/**
 * One pass over the user's nodes computing the aggregates the score needs.
 * `count(DISTINCT claims.id)` keeps the alias/source-link presence joins from
 * inflating claim counts via row fan-out.
 */
async function scoreNodeRows(
  db: PruneDatabase,
  params: {
    userId: string;
    partitionKeys: readonly (ContextPartitionKey | undefined)[];
    nodeTypes: readonly NodeType[];
    nodeIds?: readonly TypeId<"node">[];
  },
): Promise<ScoredNodeRow[]> {
  if (params.nodeTypes.length === 0 || params.nodeIds?.length === 0) return [];

  const rows = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      createdAt: nodes.createdAt,
      lastClaimAt: sql<string | null>`max(${claims.statedAt})`.as(
        "last_claim_at",
      ),
      totalClaims:
        sql<number>`cast(count(distinct ${claims.id}) as integer)`.as(
          "total_claims",
        ),
      activeClaims: sql<number>`cast(count(distinct ${claims.id}) filter (
        where ${claims.status} = 'active'
      ) as integer)`.as("active_claims"),
      supersededClaims: sql<number>`cast(count(distinct ${claims.id}) filter (
        where ${claims.status} <> 'active'
      ) as integer)`.as("superseded_claims"),
      groundedActiveClaims:
        sql<number>`cast(count(distinct ${claims.id}) filter (
        where ${claims.status} = 'active'
          and ${claims.assertedByKind} not in ('assistant_inferred', 'system')
      ) as integer)`.as("grounded_active_claims"),
      activeReferenceClaims:
        sql<number>`cast(count(distinct ${claims.id}) filter (
        where ${claims.status} = 'active' and ${claims.scope} = 'reference'
      ) as integer)`.as("active_reference_claims"),
      activePersonalClaims:
        sql<number>`cast(count(distinct ${claims.id}) filter (
        where ${claims.status} = 'active' and ${claims.scope} = 'personal'
      ) as integer)`.as("active_personal_claims"),
      hasAlias: sql<boolean>`bool_or(${aliases.id} is not null)`.as(
        "has_alias",
      ),
      hasSourceLink: sql<boolean>`bool_or(${sourceLinks.id} is not null)`.as(
        "has_source_link",
      ),
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(
      claims,
      and(
        eq(claims.userId, params.userId),
        partitionScopeCondition(
          claims.partitionKey,
          params.userId,
          params.partitionKeys,
        ),
        sql`(${claims.subjectNodeId} = ${nodes.id} or ${claims.objectNodeId} = ${nodes.id})`,
      ),
    )
    .leftJoin(
      aliases,
      and(
        eq(aliases.userId, params.userId),
        partitionScopeCondition(
          aliases.partitionKey,
          params.userId,
          params.partitionKeys,
        ),
        eq(aliases.canonicalNodeId, nodes.id),
      ),
    )
    .leftJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, params.userId),
        partitionScopeCondition(
          nodes.partitionKey,
          params.userId,
          params.partitionKeys,
        ),
        inArray(nodes.nodeType, [...params.nodeTypes]),
        ...(params.nodeIds ? [inArray(nodes.id, [...params.nodeIds])] : []),
      ),
    )
    .groupBy(nodes.id, nodes.nodeType, nodeMetadata.label, nodes.createdAt);

  return rows.map((row) => ({
    ...row,
    lastClaimAt: row.lastClaimAt === null ? null : new Date(row.lastClaimAt),
  }));
}

async function lockSelectedStaleEvidence(
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

  // Lock dependent rows in stable id order. A claim update does not need to
  // take a key-share lock on the referenced node, so the child locks close
  // that otherwise-unprotected evidence race.
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

/**
 * Node ids that must never be pruned regardless of score: subjects of a
 * currently-open task status, and the user's self-identity node(s).
 */
async function collectProtectedNodeIds(
  db: PruneDatabase,
  userId: string,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): Promise<Set<TypeId<"node">>> {
  const protectedIds = new Set<TypeId<"node">>();

  const openTaskRows = await db
    .selectDistinct({ nodeId: claims.subjectNodeId })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        partitionScopeCondition(claims.partitionKey, userId, partitionKeys),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        eq(claims.status, "active"),
        inArray(claims.objectValue, [...OPEN_TASK_STATUSES]),
      ),
    );
  for (const row of openTaskRows) protectedIds.add(row.nodeId);

  const selfMarkerRows = await db
    .select({ nodeId: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, "Person"),
        partitionScopeCondition(nodes.partitionKey, userId, partitionKeys),
        sql`${nodeMetadata.additionalData}->>'isUserSelf' = 'true'`,
      ),
    );
  for (const row of selfMarkerRows) protectedIds.add(row.nodeId);

  const [profile] = await db
    .select({ metadata: userProfiles.metadata })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const selfAliases = userProfileMetadataSchema.parse(
    profile?.metadata ?? {},
  ).userSelfAliases;
  const normalizedSelfAliases = [
    ...new Set(
      selfAliases.map((alias) => alias.trim().toLowerCase()).filter(Boolean),
    ),
  ];

  if (normalizedSelfAliases.length > 0) {
    const selfRows = await db
      .select({ nodeId: aliases.canonicalNodeId })
      .from(aliases)
      .where(
        and(
          eq(aliases.userId, userId),
          partitionScopeCondition(aliases.partitionKey, userId, partitionKeys),
          inArray(aliases.normalizedAliasText, normalizedSelfAliases),
        ),
      );
    for (const row of selfRows) protectedIds.add(row.nodeId);
  }

  return protectedIds;
}

interface ScoredCandidate {
  candidate: StaleNodeCandidate;
  isReference: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function scoreNode(
  row: ScoredNodeRow,
  opts: { now: number; stalenessHorizonDays: number },
): ScoredCandidate {
  const lastActivityMs = Math.max(
    row.createdAt.getTime(),
    row.lastClaimAt?.getTime() ?? 0,
  );
  const idleDays = Math.max(
    0,
    Math.floor((opts.now - lastActivityMs) / DAY_MS),
  );

  const staleness = clamp01(idleDays / opts.stalenessHorizonDays);
  const isolation = row.activeClaims === 0 ? 1 : 1 / (1 + row.activeClaims);
  const weakProvenance = row.groundedActiveClaims > 0 ? 0 : 1;
  const decay =
    row.totalClaims === 0 ? 1 : row.supersededClaims / row.totalClaims;

  const score = round3(
    W_STALENESS * staleness +
      W_ISOLATION * isolation +
      W_PROVENANCE * weakProvenance +
      W_DECAY * decay,
  );

  const reasons: string[] = [];
  const hasNoEvidence =
    row.totalClaims === 0 && !row.hasAlias && !row.hasSourceLink;
  if (hasNoEvidence) {
    reasons.push("no evidence (no claims, sources, or aliases)");
  }
  reasons.push(`idle ${idleDays}d`);
  if (row.activeClaims === 0 && !hasNoEvidence) {
    reasons.push("no active claims");
  } else if (row.activeClaims > 0 && row.activeClaims <= 2) {
    reasons.push(
      `weakly connected (${row.activeClaims} active claim${
        row.activeClaims === 1 ? "" : "s"
      })`,
    );
  }
  if (weakProvenance === 1 && row.totalClaims > 0) {
    reasons.push("assistant-inferred only (no grounded claims)");
  }
  if (decay >= 0.5 && row.supersededClaims > 0) {
    reasons.push(`${Math.round(decay * 100)}% of claims superseded`);
  }

  return {
    candidate: {
      id: row.id,
      nodeType: row.nodeType,
      label: row.label,
      createdAt: row.createdAt,
      lastActivityAt: new Date(lastActivityMs),
      idleDays,
      score,
      activeClaimCount: row.activeClaims,
      totalClaimCount: row.totalClaims,
      reasons,
    },
    // A node is reference-scoped iff every active scope signal is reference;
    // any active personal claim flips it back to personal (personal wins).
    isReference:
      row.activeReferenceClaims > 0 && row.activePersonalClaims === 0,
  };
}

async function deleteNodes(
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
      ),
    )
    .returning({ id: nodes.id });
  return deleted.length;
}

async function pruneStaleNodesInScope(
  db: PruneDatabase,
  input: z.output<typeof pruneStaleNodesRequestSchema>,
  partitionKeys: readonly (ContextPartitionKey | undefined)[],
): Promise<PruneStaleNodesResponse> {
  const nodeTypes = input.nodeTypes ?? [...DEFAULT_PRUNABLE_NODE_TYPES];
  const threshold = input.minScore ?? 1 - input.aggressiveness;
  const now = Date.now();

  if (!input.dryRun) {
    // Profile alias changes and self-node creation use this same transaction
    // gate. Hold it before scoring and protection reads so READ COMMITTED
    // statements observe one current identity boundary after waiting.
    await lockUserSelfIdentity(db, input.userId);
  }

  const [rows, protectedIds] = await Promise.all([
    scoreNodeRows(db, {
      userId: input.userId,
      partitionKeys,
      nodeTypes,
    }),
    collectProtectedNodeIds(db, input.userId, partitionKeys),
  ]);

  const candidates = rows
    .map((row) =>
      scoreNode(row, {
        now,
        stalenessHorizonDays: input.stalenessHorizonDays,
      }),
    )
    .filter(({ candidate, isReference }) => {
      if (protectedIds.has(candidate.id)) return false;
      if (candidate.idleDays < input.minIdleDays) return false;
      if (isReference && !input.includeReference) return false;
      return candidate.score >= threshold;
    })
    .map((scored) => scored.candidate)
    // Highest score first; node id (k-sortable) as a stable tiebreaker.
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));

  const hasMore = candidates.length > input.limit;
  const toDelete = candidates.slice(0, input.limit);

  let deletedCount = 0;
  if (!input.dryRun && toDelete.length > 0) {
    await lockSelectedStaleEvidence(
      db,
      input.userId,
      partitionKeys,
      toDelete.map((candidate) => candidate.id),
    );
    const [freshRows, freshProtectedIds] = await Promise.all([
      scoreNodeRows(db, {
        userId: input.userId,
        partitionKeys,
        nodeTypes,
        nodeIds: toDelete.map((candidate) => candidate.id),
      }),
      collectProtectedNodeIds(db, input.userId, partitionKeys),
    ]);
    const freshCandidates = freshRows
      .map((row) =>
        scoreNode(row, {
          now: Date.now(),
          stalenessHorizonDays: input.stalenessHorizonDays,
        }),
      )
      .filter(({ candidate, isReference }) => {
        if (freshProtectedIds.has(candidate.id)) return false;
        if (candidate.idleDays < input.minIdleDays) return false;
        if (isReference && !input.includeReference) return false;
        return candidate.score >= threshold;
      });
    const freshEligibleIds = new Set(
      freshCandidates.map(({ candidate }) => candidate.id),
    );
    // Never refill from candidates beyond the original global budget. A
    // concurrent evidence change may only reduce the deletion set.
    deletedCount = await deleteNodes(
      db,
      input.userId,
      partitionKeys,
      toDelete
        .map((candidate) => candidate.id)
        .filter((nodeId) => freshEligibleIds.has(nodeId)),
    );
  }

  const sample: StaleNodeCandidate[] = toDelete.slice(0, input.sampleLimit);

  logEvent("nodes.stale.pruned", {
    userId: input.userId,
    dryRun: input.dryRun,
    appliedThreshold: threshold,
    scannedCount: rows.length,
    candidateCount: candidates.length,
    deletedCount,
    hasMore,
  });

  return {
    dryRun: input.dryRun,
    appliedThreshold: threshold,
    minIdleDays: input.minIdleDays,
    scannedCount: rows.length,
    candidateCount: candidates.length,
    deletedCount,
    hasMore,
    scannedNodeTypes: nodeTypes,
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

/**
 * Score and (optionally) prune stale/low-value nodes. Dry-run returns the
 * ranked candidate set with reasons; destructive mode deletes up to `limit`
 * of the highest-scoring candidates.
 */
export async function pruneStaleNodes(
  rawInput: PruneStaleNodesRequest,
  dbOverride?: DrizzleDB,
): Promise<PruneStaleNodesResponse> {
  const input = pruneStaleNodesRequestSchema.parse(rawInput);
  const db = dbOverride ?? (await useDatabase());
  if (input.dryRun) {
    await assertPartitionReadAllowed(db, input.userId, input.partitionKey);
    return pruneStaleNodesInScope(db, input, [input.partitionKey]);
  }
  return db.transaction(async (tx) => {
    await lockUserForPrune(tx, input.userId);
    await prepareWorkspaceWrite(tx, input.userId, [input.partitionKey]);
    return pruneStaleNodesInScope(tx, input, [input.partitionKey]);
  });
}

/** Runs one deterministic workspace-wide stale sweep under one total limit. */
export async function pruneStaleNodesWorkspace(
  rawInput: PruneStaleNodesRequest,
  dbOverride?: DrizzleDB,
): Promise<PruneStaleNodesResponse> {
  const input = pruneStaleNodesRequestSchema.parse(rawInput);
  const db = dbOverride ?? (await useDatabase());
  if (input.partitionKey !== undefined) {
    return pruneStaleNodes(input, db);
  }
  if (input.dryRun) {
    const partitionKeys = await resolveWorkspacePartitions(
      db,
      input.userId,
      undefined,
      "workspace",
    );
    await assertPartitionReadAllowed(db, input.userId, undefined, "workspace");
    return pruneStaleNodesInScope(db, input, partitionKeys);
  }
  return db.transaction(async (tx) => {
    await lockUserForPrune(tx, input.userId);
    const partitionKeys = await resolveWorkspacePartitions(
      tx,
      input.userId,
      undefined,
      "workspace",
    );
    await prepareWorkspaceWrite(tx, input.userId, partitionKeys);
    return pruneStaleNodesInScope(tx, input, partitionKeys);
  });
}
