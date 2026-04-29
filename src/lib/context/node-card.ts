/**
 * Node card synthesis — assembles a `NodeCard` for a single node id.
 *
 * Used by Phase 3 read APIs (`getEntityContext`, search-as-cards). Pulls the
 * node + metadata, derives scope from source/claim support, batches alias and
 * object-label lookups, and partitions active claims by the predicate policy
 * registry into `currentFacts` (single_current_value) and `preferencesGoals`
 * (multi_value attributes that feed the atlas). Trust filter mirrors profile
 * synthesis: `assertedByKind ∈ {user, user_confirmed, system}`.
 *
 * Common aliases: NodeCard, getNodeCard, get_entity, node card synthesis.
 */
import { and, desc, eq, exists, inArray, or, sql } from "drizzle-orm";
import { listAliasesForNodeIds } from "~/lib/alias";
import {
  PREDICATE_POLICIES,
  resolvePredicatePolicy,
} from "~/lib/claims/predicate-policies";
import { getOpenCommitments } from "~/lib/query/open-commitments";
import {
  claims,
  nodeMetadata,
  nodes,
  sourceLinks,
  sources,
} from "~/db/schema";
import {
  AttributePredicateEnum,
  type AssertedByKind,
  type NodeType,
  type Predicate,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { z } from "zod";
import type {
  NodeCard,
  NodeCardCurrentFact,
  NodeCardPreferenceGoal,
  NodeCardRecentEvidence,
  NodeCardReference,
} from "./node-card-types";

export interface GetNodeCardParams {
  userId: string;
  nodeId: TypeId<"node">;
}

const TRUSTED_KINDS = [
  "user",
  "user_confirmed",
  "system",
] as const satisfies readonly AssertedByKind[];

const PREFERENCE_KINDS = [
  "user",
  "user_confirmed",
] as const satisfies readonly AssertedByKind[];

const RECENT_EVIDENCE_LIMIT = 8;

const ATTRIBUTE_PREDICATE_SET: ReadonlySet<Predicate> = new Set(
  AttributePredicateEnum.options,
);

/** Multi_value attribute predicates that feed the atlas (HAS_PREFERENCE, HAS_GOAL). */
const PREFERENCE_GOAL_PREDICATES: readonly Predicate[] = AttributePredicateEnum.options.filter(
  (predicate) => {
    const policy = PREDICATE_POLICIES[predicate];
    return policy.feedsAtlas && policy.cardinality === "multi_value";
  },
);

/**
 * Source metadata schema for reference attribution. The `sources.metadata`
 * jsonb is a flexible bag (see `src/lib/sources.ts`); we treat `author` and
 * `title` as optional string keys when scope is reference.
 */
const referenceMetadataSchema = z
  .object({
    author: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .passthrough();

interface ActiveClaimRow {
  claimId: TypeId<"claim">;
  predicate: Predicate;
  objectValue: string | null;
  objectNodeId: TypeId<"node"> | null;
  statement: string;
  statedAt: Date;
  sourceId: TypeId<"source">;
  assertedByKind: AssertedByKind;
}

/**
 * Returns whether the node has any personal-scope support (a personal source
 * link or a personal active claim touching it). Mirrors the pattern in
 * `findSimilarNodes` and `runProfileSynthesis`'s `hasPersonalScopeSupport`,
 * inlined here so we get the answer in the same row read as the node fetch.
 */
async function loadNodeBasics(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<
  | {
      nodeType: NodeType;
      label: string | null;
      summary: string | null;
      hasPersonalSupport: boolean;
      hasReferenceSupport: boolean;
    }
  | null
> {
  const db = await useDatabase();

  const personalSourceLink = db
    .select({ one: sql<number>`1` })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodeId),
        eq(sources.userId, userId),
        eq(sources.scope, "personal"),
      ),
    );

  const personalClaim = db
    .select({ one: sql<number>`1` })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "personal"),
        eq(claims.status, "active"),
        or(
          eq(claims.subjectNodeId, nodeId),
          eq(claims.objectNodeId, nodeId),
        ),
      ),
    );

  const referenceSourceLink = db
    .select({ one: sql<number>`1` })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodeId),
        eq(sources.userId, userId),
        eq(sources.scope, "reference"),
      ),
    );

  const referenceClaim = db
    .select({ one: sql<number>`1` })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "reference"),
        eq(claims.status, "active"),
        or(
          eq(claims.subjectNodeId, nodeId),
          eq(claims.objectNodeId, nodeId),
        ),
      ),
    );

  const [row] = await db
    .select({
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      summary: nodeMetadata.description,
      hasPersonalSupport: sql<boolean>`(${exists(personalSourceLink)} OR ${exists(personalClaim)})`,
      hasReferenceSupport: sql<boolean>`(${exists(referenceSourceLink)} OR ${exists(referenceClaim)})`,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!row) return null;
  return {
    nodeType: row.nodeType,
    label: row.label,
    summary: row.summary,
    hasPersonalSupport: row.hasPersonalSupport === true,
    hasReferenceSupport: row.hasReferenceSupport === true,
  };
}

/**
 * Personal scope wins when both flags are set: the design treats personal
 * support as the dominant signal so a node touched by both a reference doc
 * and the user's own claims is still searchable in `searchMemory`.
 */
function deriveScope(
  hasPersonalSupport: boolean,
  hasReferenceSupport: boolean,
): Scope {
  if (hasPersonalSupport) return "personal";
  if (hasReferenceSupport) return "reference";
  return "personal";
}

async function loadActiveClaimsForSubject(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<ActiveClaimRow[]> {
  const db = await useDatabase();
  return db
    .select({
      claimId: claims.id,
      predicate: claims.predicate,
      objectValue: claims.objectValue,
      objectNodeId: claims.objectNodeId,
      statement: claims.statement,
      statedAt: claims.statedAt,
      sourceId: claims.sourceId,
      assertedByKind: claims.assertedByKind,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, nodeId),
        eq(claims.status, "active"),
      ),
    )
    .orderBy(desc(claims.statedAt), desc(claims.createdAt));
}

async function batchResolveLabels(
  nodeIds: TypeId<"node">[],
): Promise<Map<TypeId<"node">, string | null>> {
  const result = new Map<TypeId<"node">, string | null>();
  if (nodeIds.length === 0) return result;
  const db = await useDatabase();
  const rows = await db
    .select({ nodeId: nodeMetadata.nodeId, label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(inArray(nodeMetadata.nodeId, nodeIds));
  for (const row of rows) {
    result.set(row.nodeId, row.label);
  }
  return result;
}

/**
 * Collect canonical label + alias rows, deduplicated by lowercased text,
 * preserving canonical-first ordering.
 */
async function buildAliasList(
  userId: string,
  nodeId: TypeId<"node">,
  canonicalLabel: string,
): Promise<string[]> {
  const db = await useDatabase();
  const aliasMap = await listAliasesForNodeIds(db, userId, [nodeId]);
  const aliasRows = aliasMap.get(nodeId) ?? [];

  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (text: string): void => {
    const key = text.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) return;
    seen.add(key);
    ordered.push(text);
  };

  push(canonicalLabel);
  for (const alias of aliasRows) push(alias.aliasText);
  return ordered;
}

/**
 * For reference nodes we walk `sourceLinks → sources` to find author/title in
 * source metadata. The most-recent reference source wins (most-recent =
 * largest `lastIngestedAt`, falling back to `createdAt`) so a re-ingested
 * version of the same book overrides stale metadata.
 */
async function loadReferenceMetadata(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<NodeCardReference | null> {
  const db = await useDatabase();
  const rows = await db
    .select({ metadata: sources.metadata })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodeId),
        eq(sources.userId, userId),
        eq(sources.scope, "reference"),
      ),
    )
    .orderBy(desc(sources.lastIngestedAt), desc(sources.createdAt));

  for (const row of rows) {
    const parsed = referenceMetadataSchema.safeParse(row.metadata ?? {});
    if (!parsed.success) continue;
    const author = parsed.data.author ?? null;
    const title = parsed.data.title ?? null;
    if (author === null && title === null) continue;
    return { author, title };
  }
  return null;
}

function isCurrentFactClaim(
  claim: ActiveClaimRow,
  subjectType: NodeType,
): boolean {
  if (!TRUSTED_KINDS.includes(claim.assertedByKind as (typeof TRUSTED_KINDS)[number])) {
    return false;
  }
  const policy = resolvePredicatePolicy(claim.predicate, subjectType);
  return (
    policy.cardinality === "single_current_value" &&
    policy.lifecycle === "supersede_previous"
  );
}

function isPreferenceGoalClaim(claim: ActiveClaimRow): boolean {
  if (!PREFERENCE_GOAL_PREDICATES.includes(claim.predicate)) return false;
  if (!ATTRIBUTE_PREDICATE_SET.has(claim.predicate)) return false;
  return PREFERENCE_KINDS.includes(claim.assertedByKind as (typeof PREFERENCE_KINDS)[number]);
}

export async function getNodeCard(
  params: GetNodeCardParams,
): Promise<NodeCard | null> {
  const { userId, nodeId } = params;

  const basics = await loadNodeBasics(userId, nodeId);
  if (basics === null) return null;

  const scope = deriveScope(
    basics.hasPersonalSupport,
    basics.hasReferenceSupport,
  );

  const [activeClaims, aliasList] = await Promise.all([
    loadActiveClaimsForSubject(userId, nodeId),
    buildAliasList(userId, nodeId, basics.label ?? ""),
  ]);

  // Object-label resolution for relationship claims: batch lookup once.
  const relationshipObjectIds = activeClaims
    .filter((claim) => claim.objectNodeId !== null)
    .map((claim) => claim.objectNodeId as TypeId<"node">);
  const labelByNodeId = await batchResolveLabels(relationshipObjectIds);

  const currentFacts: NodeCardCurrentFact[] = [];
  const preferencesGoals: NodeCardPreferenceGoal[] = [];

  for (const claim of activeClaims) {
    if (isCurrentFactClaim(claim, basics.nodeType)) {
      currentFacts.push({
        predicate: claim.predicate,
        objectValue: claim.objectValue,
        objectNodeId: claim.objectNodeId,
        objectLabel:
          claim.objectNodeId === null
            ? null
            : labelByNodeId.get(claim.objectNodeId) ?? null,
        statement: claim.statement,
        statedAt: claim.statedAt,
        evidence: { claimId: claim.claimId, sourceId: claim.sourceId },
      });
      continue;
    }
    if (isPreferenceGoalClaim(claim)) {
      // Narrow to AttributePredicate after the predicate-set guard so the
      // schema's `AttributePredicateEnum` type holds.
      const attrPredicate = AttributePredicateEnum.parse(claim.predicate);
      preferencesGoals.push({
        predicate: attrPredicate,
        objectValue: claim.objectValue,
        statement: claim.statement,
        statedAt: claim.statedAt,
        evidence: { claimId: claim.claimId, sourceId: claim.sourceId },
      });
    }
  }

  const recentEvidence: NodeCardRecentEvidence[] = activeClaims
    .filter((claim) => claim.assertedByKind !== "assistant_inferred")
    .slice(0, RECENT_EVIDENCE_LIMIT)
    .map((claim) => ({
      statement: claim.statement,
      sourceId: claim.sourceId,
      statedAt: claim.statedAt,
    }));

  const card: NodeCard = {
    nodeId,
    nodeType: basics.nodeType,
    label: basics.label ?? "",
    aliases: aliasList,
    scope,
    summary: basics.summary,
    currentFacts,
    preferencesGoals,
    recentEvidence,
  };

  if (basics.nodeType === "Person") {
    const commitments = await getOpenCommitments({
      userId,
      ownedBy: nodeId,
    });
    if (commitments.length > 0) {
      card.openCommitments = commitments;
    }
  }

  if (scope === "reference") {
    const referenceMeta = await loadReferenceMetadata(userId, nodeId);
    if (referenceMeta !== null) {
      card.reference = referenceMeta;
    }
  }

  return card;
}
