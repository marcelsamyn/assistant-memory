/** Node merge redirects: follow a consumed node id to its current survivor. */
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeRedirects } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

/** Accepts the db or an open transaction. */
type Database =
  | DrizzleDB
  | Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];

/**
 * Record that `consumedIds` merged into `survivorId`. Re-points any existing
 * redirect that targeted a consumed id at the new survivor so chains stay flat
 * (max one hop). Idempotent on (userId, fromNodeId).
 */
export async function writeNodeRedirects(
  db: Database,
  userId: string,
  survivorId: TypeId<"node">,
  consumedIds: TypeId<"node">[],
): Promise<void> {
  if (consumedIds.length === 0) return;

  await db
    .update(nodeRedirects)
    .set({ toNodeId: survivorId })
    .where(
      and(
        eq(nodeRedirects.userId, userId),
        inArray(nodeRedirects.toNodeId, consumedIds),
      ),
    );

  await db
    .insert(nodeRedirects)
    .values(
      consumedIds.map((fromNodeId) => ({
        userId,
        fromNodeId,
        toNodeId: survivorId,
      })),
    )
    .onConflictDoUpdate({
      target: [nodeRedirects.userId, nodeRedirects.fromNodeId],
      set: { toNodeId: survivorId },
    });
}

/**
 * Map possibly-stale node ids to their current canonical id. Ids with no
 * redirect map to themselves. One round-trip.
 */
export async function resolveNodeRedirects(
  db: Database,
  userId: string,
  ids: TypeId<"node">[],
): Promise<Map<TypeId<"node">, TypeId<"node">>> {
  const out = new Map<TypeId<"node">, TypeId<"node">>(
    ids.map((id) => [id, id]),
  );
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      fromNodeId: nodeRedirects.fromNodeId,
      toNodeId: nodeRedirects.toNodeId,
    })
    .from(nodeRedirects)
    .where(
      and(
        eq(nodeRedirects.userId, userId),
        inArray(nodeRedirects.fromNodeId, ids),
      ),
    );
  for (const r of rows) out.set(r.fromNodeId, r.toNodeId);
  return out;
}
