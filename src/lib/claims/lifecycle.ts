/** Claim lifecycle transitions for sourced claims. Common aliases: supersession, claim lifecycle, single-valued claim policy. */
import {
  PREDICATE_POLICIES,
  resolvePredicatePolicy,
} from "./predicate-policies";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodes } from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import type { AssertedByKind, NodeType, Predicate } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

type ClaimRow = typeof claims.$inferSelect;

interface SingleValuedSubject {
  userId: string;
  subjectNodeId: TypeId<"node">;
  subjectType: NodeType;
  predicate: Predicate;
}

const TRUSTED_USER_KINDS: ReadonlySet<AssertedByKind> = new Set([
  "user",
  "user_confirmed",
]);

// Higher number = higher trust, used as a tiebreaker among ties on (statedAt, createdAt).
const ASSERTED_BY_KIND_TRUST_RANK: Record<AssertedByKind, number> = {
  user: 5,
  user_confirmed: 5,
  participant: 4,
  document_author: 3,
  assistant_inferred: 2,
  system: 1,
};

// Predicates that are single-current-value for at least one subject context
// (base or any override). Any (predicate, subjectType) pair outside this set
// can never trigger supersession — used as a cheap pre-filter before we pay
// for a `nodes` lookup.
const POTENTIALLY_SUPERSEDING_PREDICATES: ReadonlySet<Predicate> = new Set(
  Object.values(PREDICATE_POLICIES)
    .filter((entry) => {
      if (
        entry.cardinality === "single_current_value" &&
        entry.lifecycle === "supersede_previous"
      ) {
        return true;
      }
      const overrides = entry.subjectTypeOverrides;
      if (overrides === undefined) return false;
      return Object.values(overrides).some(
        (override) =>
          override !== undefined &&
          override.cardinality === "single_current_value" &&
          override.lifecycle === "supersede_previous",
      );
    })
    .map((entry) => entry.predicate),
);

async function fetchSubjectTypes(
  database: DrizzleDB,
  subjectNodeIds: ReadonlySet<TypeId<"node">>,
): Promise<Map<TypeId<"node">, NodeType>> {
  if (subjectNodeIds.size === 0) return new Map();
  const rows = await database
    .select({ id: nodes.id, nodeType: nodes.nodeType })
    .from(nodes)
    .where(inArray(nodes.id, [...subjectNodeIds]));
  return new Map(rows.map((row) => [row.id, row.nodeType]));
}

async function singleCurrentValueSubjects(
  database: DrizzleDB,
  changedClaims: ClaimRow[],
): Promise<SingleValuedSubject[]> {
  const candidates = changedClaims.filter((claim) =>
    POTENTIALLY_SUPERSEDING_PREDICATES.has(claim.predicate),
  );
  if (candidates.length === 0) return [];

  const subjectTypes = await fetchSubjectTypes(
    database,
    new Set(candidates.map((claim) => claim.subjectNodeId)),
  );

  const subjects = new Map<string, SingleValuedSubject>();
  for (const claim of candidates) {
    const subjectType = subjectTypes.get(claim.subjectNodeId);
    if (subjectType === undefined) continue;
    const policy = resolvePredicatePolicy(claim.predicate, subjectType);
    if (
      policy.cardinality !== "single_current_value" ||
      policy.lifecycle !== "supersede_previous"
    ) {
      continue;
    }
    // (userId, subjectNodeId, predicate) is unique per claim in the DB
    // because subjectNodeId already pins a single subjectType row. We pass
    // subjectType through so the recompute step doesn't re-lookup.
    const key = `${claim.userId}|${claim.subjectNodeId}|${claim.predicate}`;
    subjects.set(key, {
      userId: claim.userId,
      subjectNodeId: claim.subjectNodeId,
      subjectType,
      predicate: claim.predicate,
    });
  }
  return [...subjects.values()];
}

function compareLifecycleOrder(a: ClaimRow, b: ClaimRow): number {
  const statedAtOrder = a.statedAt.getTime() - b.statedAt.getTime();
  if (statedAtOrder !== 0) return statedAtOrder;

  const createdAtOrder = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdAtOrder !== 0) return createdAtOrder;

  // Trust tiebreaker — among truly tied timestamps, prefer the higher-trust
  // kind as the later (winning) claim. Lower trust comes first (i.e. earlier
  // in the sorted order, so it ends up superseded).
  const trustOrder =
    ASSERTED_BY_KIND_TRUST_RANK[a.assertedByKind] -
    ASSERTED_BY_KIND_TRUST_RANK[b.assertedByKind];
  if (trustOrder !== 0) return trustOrder;

  return a.id.localeCompare(b.id);
}

/**
 * Trust rule: if the latest claim by statedAt is `assistant_inferred` AND any
 * prior claim (any earlier statedAt) for the same (user, subject, predicate)
 * triple is asserted by `user`/`user_confirmed`, the new claim is forced to
 * `superseded` immediately and the prior remains active.
 *
 * Returns the demoted claim id if the rule fires, or null otherwise.
 */
function trustRuleDemotedClaimId(sortedClaims: ClaimRow[]): string | null {
  if (sortedClaims.length < 2) return null;
  const latest = sortedClaims[sortedClaims.length - 1]!;
  if (latest.assertedByKind !== "assistant_inferred") return null;

  const hasPriorTrustedUserClaim = sortedClaims
    .slice(0, -1)
    .some((claim) => TRUSTED_USER_KINDS.has(claim.assertedByKind));
  return hasPriorTrustedUserClaim ? latest.id : null;
}

async function recomputeSingleValuedLifecycleForSubject(
  database: DrizzleDB,
  subject: SingleValuedSubject,
): Promise<void> {
  // Defensive: caller already filtered, but resolving here keeps this fn
  // safe to call directly (e.g. from backfill scripts).
  const policy = resolvePredicatePolicy(subject.predicate, subject.subjectType);
  if (
    policy.cardinality !== "single_current_value" ||
    policy.lifecycle !== "supersede_previous"
  ) {
    return;
  }

  const subjectClaims = (
    await database
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.userId, subject.userId),
          eq(claims.subjectNodeId, subject.subjectNodeId),
          eq(claims.predicate, subject.predicate),
          inArray(claims.status, ["active", "superseded"]),
        ),
      )
  ).sort(compareLifecycleOrder);

  if (subjectClaims.length === 0) return;

  const demotedClaimId = trustRuleDemotedClaimId(subjectClaims);

  // Partition into the chain that participates in normal supersession ordering
  // vs. the trust-demoted claim (if any), which is forced into the superseded
  // slot regardless of timestamp.
  const orderedChain = demotedClaimId
    ? subjectClaims.filter((claim) => claim.id !== demotedClaimId)
    : subjectClaims;
  const demotedClaim = demotedClaimId
    ? subjectClaims.find((claim) => claim.id === demotedClaimId)
    : undefined;

  const updatedAt = new Date();
  const updates: Array<Promise<unknown>> = [];
  const newlySuperseded: Array<{
    claimId: TypeId<"claim">;
    supersededByClaimId: TypeId<"claim"> | null;
  }> = [];

  // Latest active claim (top of orderedChain) — used as the supersedor for the
  // trust-demoted claim if any.
  const latestActive = orderedChain[orderedChain.length - 1];

  for (let index = 0; index < orderedChain.length; index++) {
    const claim = orderedChain[index]!;
    const nextClaim = orderedChain[index + 1];
    const isLatestActive = nextClaim === undefined;
    const validFrom = claim.validFrom ?? claim.statedAt;
    const validTo = isLatestActive
      ? claim.status === "superseded"
        ? null
        : claim.validTo
      : nextClaim.statedAt;

    updates.push(
      database
        .update(claims)
        .set({
          status: isLatestActive ? "active" : "superseded",
          validFrom,
          validTo,
          supersededByClaimId: isLatestActive ? null : nextClaim.id,
          updatedAt,
        })
        .where(eq(claims.id, claim.id)),
    );
    if (!isLatestActive && claim.status !== "superseded") {
      newlySuperseded.push({
        claimId: claim.id,
        supersededByClaimId: nextClaim.id,
      });
    }
  }

  if (demotedClaim) {
    const validFrom = demotedClaim.validFrom ?? demotedClaim.statedAt;
    updates.push(
      database
        .update(claims)
        .set({
          status: "superseded",
          validFrom,
          validTo: demotedClaim.statedAt,
          supersededByClaimId: latestActive ? latestActive.id : null,
          updatedAt,
        })
        .where(eq(claims.id, demotedClaim.id)),
    );
    if (demotedClaim.status !== "superseded") {
      newlySuperseded.push({
        claimId: demotedClaim.id,
        supersededByClaimId: latestActive ? latestActive.id : null,
      });
    }
  }

  await Promise.all(updates);

  for (const transition of newlySuperseded) {
    logEvent("claim.superseded", {
      claimId: transition.claimId,
      userId: subject.userId,
      predicate: subject.predicate,
      supersededByClaimId: transition.supersededByClaimId,
      subjectNodeId: subject.subjectNodeId,
    });
  }
}

/** Apply single-valued claim lifecycle rules. Common aliases: supersession, claim lifecycle. */
export async function applyClaimLifecycle(
  database: DrizzleDB,
  changedClaims: ClaimRow[],
): Promise<void> {
  const subjects = await singleCurrentValueSubjects(database, changedClaims);
  await Promise.all(
    subjects.map((subject) =>
      recomputeSingleValuedLifecycleForSubject(database, subject),
    ),
  );
}

export async function fetchClaimsByIds(
  database: DrizzleDB,
  claimIds: Array<ClaimRow["id"]>,
): Promise<ClaimRow[]> {
  if (claimIds.length === 0) return [];

  return database.select().from(claims).where(inArray(claims.id, claimIds));
}

/** Recompute lifecycle for an explicit (user, subject, predicate) — exposed for backfill scripts. */
export async function recomputeSingleValuedLifecycle(
  database: DrizzleDB,
  subject: {
    userId: string;
    subjectNodeId: TypeId<"node">;
    subjectType: NodeType;
    predicate: Predicate;
  },
): Promise<void> {
  await recomputeSingleValuedLifecycleForSubject(database, subject);
}
