/**
 * Atlas invalidation hook.
 *
 * Phase 2b.9 deferred this until a real consumer existed; Phase 3.4 wires it.
 * Today the only consumer that needs supersession-driven refresh is the
 * user atlas itself — bundle/read-model caches arrive in Phase 3.5 and will
 * subscribe to a similar signal then.
 *
 * Common aliases: atlas refresh trigger, force-refresh hook,
 * forceRefreshOnSupersede dispatch.
 */
import { PREDICATE_POLICIES } from "../claims/predicate-policies";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims } from "~/db/schema";
import type { Predicate } from "~/types/graph";

const FORCE_REFRESH_PREDICATES: readonly Predicate[] = Object.values(
  PREDICATE_POLICIES,
)
  .filter((policy) => policy.forceRefreshOnSupersede)
  .map((policy) => policy.predicate);

/**
 * Returns true if any claim with `forceRefreshOnSupersede = true` transitioned
 * out of `active` since the given timestamp. Caller should capture `since`
 * immediately before invoking `applyClaimLifecycle`.
 *
 * `forceRefreshOnSupersede` is uniform per predicate (no subject-type axis),
 * so a flat predicate filter is exhaustive.
 */
export async function hasAtlasInvalidatingSupersession(
  db: DrizzleDB,
  userId: string,
  since: Date,
): Promise<boolean> {
  if (FORCE_REFRESH_PREDICATES.length === 0) return false;
  const [row] = await db
    .select({ id: claims.id })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        inArray(claims.predicate, [...FORCE_REFRESH_PREDICATES]),
        inArray(claims.status, ["superseded", "contradicted", "retracted"]),
        gte(claims.updatedAt, since),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Debounce window for supersession-triggered atlas refresh. Mirrors the
 * profile-synthesis debounce — a multi-message burst that flips several
 * statuses in quick succession collapses to one synthesis run.
 */
const ATLAS_SUPERSEDE_DEBOUNCE_MS = 5 * 60_000;

/**
 * Enqueue a supersession-triggered atlas refresh. Idempotent within the
 * debounce window via a stable jobId; BullMQ's `delay` plus `jobId`
 * deduplication collapses bursts.
 */
export async function enqueueAtlasUserRefreshOnSupersede(
  userId: string,
): Promise<void> {
  const { batchQueue } = await import("../queues");
  await batchQueue.add(
    "atlas-user",
    { userId, trigger: "supersede" },
    {
      jobId: `atlas-user:${userId}:supersede`,
      delay: ATLAS_SUPERSEDE_DEBOUNCE_MS,
      removeOnComplete: true,
      removeOnFail: 50,
    },
  );
}

/**
 * Combined helper: detect-and-enqueue. Call after `applyClaimLifecycle` from
 * insertion-flow sites. The `since` capture must happen on the caller side
 * before lifecycle runs.
 */
export async function maybeEnqueueAtlasInvalidation(
  db: DrizzleDB,
  userId: string,
  since: Date,
): Promise<boolean> {
  const triggered = await hasAtlasInvalidatingSupersession(db, userId, since);
  if (!triggered) return false;
  await enqueueAtlasUserRefreshOnSupersede(userId);
  return true;
}
