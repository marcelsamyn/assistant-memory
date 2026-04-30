/**
 * Node card synthesis — assembles a `NodeCard` for one or more node ids.
 *
 * Used by Phase 3 read APIs (`getEntityContext`, `searchMemory`,
 * `searchReference`). Pulls the node + metadata, derives scope from
 * source/claim support, batches alias and object-label lookups, and
 * partitions active claims by the predicate policy registry into
 * `currentFacts` (single_current_value) and `preferencesGoals` (multi_value
 * attributes that feed the atlas). Trust filter mirrors profile synthesis:
 * `assertedByKind ∈ {user, user_confirmed, system}`.
 *
 * `getNodeCards` is the batch entry point — search APIs flow N nodeIds
 * through one round of queries instead of N×6. `getNodeCard` is a thin
 * single-id wrapper.
 *
 * Common aliases: NodeCard, getNodeCard, getNodeCards, get_entity, node card
 * synthesis, batch node card.
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

export interface GetNodeCardsParams {
  userId: string;
  nodeIds: readonly TypeId<"node">[];
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

interface NodeBasics {
  nodeType: NodeType;
  label: string | null;
  summary: string | null;
  hasPersonalSupport: boolean;
  hasReferenceSupport: boolean;
}

interface ActiveClaimRow {
  subjectNodeId: TypeId<"node">;
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
 * Batch fetch of node basics with per-row scope-support flags. The `EXISTS`
 * subqueries are correlated against `nodes.id`, so a single query returns one
 * row per node with the same answers the per-id version computed.
 */
async function loadNodesBasicsMany(
  userId: string,
  nodeIds: readonly TypeId<"node">[],
): Promise<Map<TypeId<"node">, NodeBasics>> {
  const result = new Map<TypeId<"node">, NodeBasics>();
  if (nodeIds.length === 0) return result;
  const db = await useDatabase();

  const personalSourceLink = db
    .select({ one: sql<number>`1` })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodes.id),
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
          eq(claims.subjectNodeId, nodes.id),
          eq(claims.objectNodeId, nodes.id),
        ),
      ),
    );

  const referenceSourceLink = db
    .select({ one: sql<number>`1` })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodes.id),
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
          eq(claims.subjectNodeId, nodes.id),
          eq(claims.objectNodeId, nodes.id),
        ),
      ),
    );

  const rows = await db
    .select({
      nodeId: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      summary: nodeMetadata.description,
      hasPersonalSupport: sql<boolean>`(${exists(personalSourceLink)} OR ${exists(personalClaim)})`,
      hasReferenceSupport: sql<boolean>`(${exists(referenceSourceLink)} OR ${exists(referenceClaim)})`,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds as TypeId<"node">[])),
    );

  for (const row of rows) {
    result.set(row.nodeId, {
      nodeType: row.nodeType,
      label: row.label,
      summary: row.summary,
      hasPersonalSupport: row.hasPersonalSupport === true,
      hasReferenceSupport: row.hasReferenceSupport === true,
    });
  }
  return result;
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

/**
 * Batch fetch of active claims for the given subject node ids, grouped by
 * subject. Within each group rows are returned newest-first (matches the
 * per-card ordering used by `currentFacts` / `recentEvidence`).
 */
async function loadActiveClaimsBySubjectMany(
  userId: string,
  nodeIds: readonly TypeId<"node">[],
): Promise<Map<TypeId<"node">, ActiveClaimRow[]>> {
  const result = new Map<TypeId<"node">, ActiveClaimRow[]>();
  if (nodeIds.length === 0) return result;
  const db = await useDatabase();
  const rows = await db
    .select({
      subjectNodeId: claims.subjectNodeId,
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
        inArray(claims.subjectNodeId, nodeIds as TypeId<"node">[]),
        eq(claims.status, "active"),
      ),
    )
    .orderBy(desc(claims.statedAt), desc(claims.createdAt));

  for (const nodeId of nodeIds) result.set(nodeId, []);
  for (const row of rows) {
    const bucket = result.get(row.subjectNodeId);
    if (bucket) bucket.push(row);
  }
  return result;
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
 * Build the alias list (canonical first, dedup case-insensitive) for a single
 * node from a pre-fetched alias map. Centralized here so `getNodeCards` can
 * fetch all alias rows in one round-trip.
 */
function buildAliasListFromMap(
  nodeId: TypeId<"node">,
  canonicalLabel: string,
  aliasMap: Map<TypeId<"node">, { aliasText: string }[]>,
): string[] {
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
 * Batch reference-metadata lookup. Returns the most-recent reference source
 * (largest `lastIngestedAt`, fallback `createdAt`) per node id, mirroring the
 * per-id behavior so re-ingested versions of the same book override stale
 * metadata.
 */
async function loadReferenceMetadataMany(
  userId: string,
  nodeIds: readonly TypeId<"node">[],
): Promise<Map<TypeId<"node">, NodeCardReference>> {
  const result = new Map<TypeId<"node">, NodeCardReference>();
  if (nodeIds.length === 0) return result;
  const db = await useDatabase();
  const rows = await db
    .select({
      nodeId: sourceLinks.nodeId,
      metadata: sources.metadata,
    })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.scope, "reference"),
        inArray(sourceLinks.nodeId, nodeIds as TypeId<"node">[]),
      ),
    )
    .orderBy(desc(sources.lastIngestedAt), desc(sources.createdAt));

  for (const row of rows) {
    if (result.has(row.nodeId)) continue; // first-wins per node
    const parsed = referenceMetadataSchema.safeParse(row.metadata ?? {});
    if (!parsed.success) continue;
    const author = parsed.data.author ?? null;
    const title = parsed.data.title ?? null;
    if (author === null && title === null) continue;
    result.set(row.nodeId, { author, title });
  }
  return result;
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

function assembleCard(
  nodeId: TypeId<"node">,
  basics: NodeBasics,
  activeClaims: ActiveClaimRow[],
  aliasList: string[],
  labelByNodeId: Map<TypeId<"node">, string | null>,
  referenceMeta: NodeCardReference | undefined,
  openCommitments: NodeCard["openCommitments"] | undefined,
): NodeCard {
  const scope = deriveScope(basics.hasPersonalSupport, basics.hasReferenceSupport);

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

  if (openCommitments && openCommitments.length > 0) {
    card.openCommitments = openCommitments;
  }
  if (scope === "reference" && referenceMeta) {
    card.reference = referenceMeta;
  }
  return card;
}

/**
 * Batch entry point. Returns a `Map` keyed by node id; ids that don't resolve
 * (deleted or wrong user) are simply absent from the result. Used by the
 * card-shaped search APIs and `getEntityContext` so a 10-card response stays
 * O(constant DB round-trips) instead of O(N).
 */
export async function getNodeCards(
  params: GetNodeCardsParams,
): Promise<Map<TypeId<"node">, NodeCard>> {
  const { userId } = params;
  const uniqueIds = [...new Set(params.nodeIds)];
  const result = new Map<TypeId<"node">, NodeCard>();
  if (uniqueIds.length === 0) return result;

  const basicsMap = await loadNodesBasicsMany(userId, uniqueIds);
  const resolvedIds = uniqueIds.filter((id) => basicsMap.has(id));
  if (resolvedIds.length === 0) return result;

  const db = await useDatabase();
  const [claimsBySubject, aliasMap] = await Promise.all([
    loadActiveClaimsBySubjectMany(userId, resolvedIds),
    listAliasesForNodeIds(db, userId, resolvedIds),
  ]);

  // Collect all relationship object node ids and reference-scope ids in one
  // pass so the next two batch queries are minimal.
  const objectIdSet = new Set<TypeId<"node">>();
  const referenceCandidates: TypeId<"node">[] = [];
  const personIds: TypeId<"node">[] = [];
  for (const id of resolvedIds) {
    const basics = basicsMap.get(id)!;
    const claimsForId = claimsBySubject.get(id) ?? [];
    for (const claim of claimsForId) {
      if (claim.objectNodeId !== null) objectIdSet.add(claim.objectNodeId);
    }
    const scope = deriveScope(
      basics.hasPersonalSupport,
      basics.hasReferenceSupport,
    );
    if (scope === "reference") referenceCandidates.push(id);
    if (basics.nodeType === "Person") personIds.push(id);
  }

  const [labelByNodeId, referenceMetaByNodeId, openCommitmentsByPerson] =
    await Promise.all([
      batchResolveLabels(Array.from(objectIdSet)),
      loadReferenceMetadataMany(userId, referenceCandidates),
      loadOpenCommitmentsForPersons(userId, personIds),
    ]);

  for (const nodeId of resolvedIds) {
    const basics = basicsMap.get(nodeId)!;
    const aliasList = buildAliasListFromMap(
      nodeId,
      basics.label ?? "",
      aliasMap,
    );
    const card = assembleCard(
      nodeId,
      basics,
      claimsBySubject.get(nodeId) ?? [],
      aliasList,
      labelByNodeId,
      referenceMetaByNodeId.get(nodeId),
      openCommitmentsByPerson.get(nodeId),
    );
    result.set(nodeId, card);
  }
  return result;
}

/**
 * Per-Person open-commitments fetch. `getOpenCommitments` already queries the
 * subset of claims under HAS_TASK_STATUS / OWNED_BY / DUE_ON; running it in
 * parallel for the small subset of Person ids in a card batch is the simplest
 * shape until the read-model pipeline lands a true batch query.
 */
async function loadOpenCommitmentsForPersons(
  userId: string,
  personIds: readonly TypeId<"node">[],
): Promise<Map<TypeId<"node">, NodeCard["openCommitments"]>> {
  const result = new Map<TypeId<"node">, NodeCard["openCommitments"]>();
  if (personIds.length === 0) return result;
  const entries = await Promise.all(
    personIds.map(async (id) => {
      const commitments = await getOpenCommitments({ userId, ownedBy: id });
      return [id, commitments] as const;
    }),
  );
  for (const [id, commitments] of entries) {
    result.set(id, commitments);
  }
  return result;
}

export async function getNodeCard(
  params: GetNodeCardParams,
): Promise<NodeCard | null> {
  const cards = await getNodeCards({
    userId: params.userId,
    nodeIds: [params.nodeId],
  });
  return cards.get(params.nodeId) ?? null;
}
