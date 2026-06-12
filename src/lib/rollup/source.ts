/**
 * Synthetic per-user source backing rollup-generated PART_OF claims
 * (`claims.sourceId` is NOT NULL and containment claims have no natural
 * ingestion source). Mirrors the metric-source pattern in
 * `src/lib/metrics/sources.ts`.
 */
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

const ROLLUP_EXTERNAL_ID = "rollup";

export async function ensureRollupSource(
  db: DrizzleDB,
  userId: string,
): Promise<TypeId<"source">> {
  const [inserted] = await db
    .insert(sources)
    .values({
      userId,
      type: "rollup",
      externalId: ROLLUP_EXTERNAL_ID,
      scope: "personal",
      status: "completed",
    })
    .onConflictDoNothing({
      target: [sources.userId, sources.type, sources.externalId],
    })
    .returning({ id: sources.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.type, "rollup"),
        eq(sources.externalId, ROLLUP_EXTERNAL_ID),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`Failed to ensure rollup source for user ${userId}`);
  }
  return existing.id;
}
