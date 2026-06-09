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
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  nodeMetadata,
  nodes,
  sourceLinks,
  userProfiles,
} from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import {
  pruneStaleNodesRequestSchema,
  type PruneStaleNodesRequest,
  type PruneStaleNodesResponse,
  type StaleNodeCandidate,
} from "~/lib/schemas/prune-stale-nodes";
import { userProfileMetadataSchema } from "~/lib/schemas/user-profile-metadata";
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
  db: DrizzleDB,
  params: { userId: string; nodeTypes: readonly NodeType[] },
): Promise<ScoredNodeRow[]> {
  if (params.nodeTypes.length === 0) return [];

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
        sql`(${claims.subjectNodeId} = ${nodes.id} or ${claims.objectNodeId} = ${nodes.id})`,
      ),
    )
    .leftJoin(
      aliases,
      and(
        eq(aliases.userId, params.userId),
        eq(aliases.canonicalNodeId, nodes.id),
      ),
    )
    .leftJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, params.userId),
        inArray(nodes.nodeType, [...params.nodeTypes]),
      ),
    )
    .groupBy(nodes.id, nodes.nodeType, nodeMetadata.label, nodes.createdAt);

  return rows.map((row) => ({
    ...row,
    lastClaimAt: row.lastClaimAt === null ? null : new Date(row.lastClaimAt),
  }));
}

/**
 * Node ids that must never be pruned regardless of score: subjects of a
 * currently-open task status, and the user's self-identity node(s).
 */
async function collectProtectedNodeIds(
  db: DrizzleDB,
  userId: string,
): Promise<Set<TypeId<"node">>> {
  const protectedIds = new Set<TypeId<"node">>();

  const openTaskRows = await db
    .selectDistinct({ nodeId: claims.subjectNodeId })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        eq(claims.status, "active"),
        inArray(claims.objectValue, [...OPEN_TASK_STATUSES]),
      ),
    );
  for (const row of openTaskRows) protectedIds.add(row.nodeId);

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
  db: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<number> {
  if (nodeIds.length === 0) return 0;
  const deleted = await db
    .delete(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)))
    .returning({ id: nodes.id });
  return deleted.length;
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
  const nodeTypes = input.nodeTypes ?? [...DEFAULT_PRUNABLE_NODE_TYPES];
  const threshold = input.minScore ?? 1 - input.aggressiveness;
  const now = Date.now();

  const [rows, protectedIds] = await Promise.all([
    scoreNodeRows(db, { userId: input.userId, nodeTypes }),
    collectProtectedNodeIds(db, input.userId),
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

  const deletedCount = input.dryRun
    ? 0
    : await deleteNodes(
        db,
        input.userId,
        toDelete.map((candidate) => candidate.id),
      );

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
