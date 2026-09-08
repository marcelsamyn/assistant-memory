/**
 * Synthetic per-user source backing rollup-generated PART_OF claims
 * (`claims.sourceId` is NOT NULL and containment claims have no natural
 * ingestion source). Mirrors the metric-source pattern in
 * `src/lib/metrics/sources.ts`.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { preparePartitionWrite } from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { TypeId } from "~/types/typeid";

const ROLLUP_EXTERNAL_ID = "rollup";

export async function ensureRollupSource(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
): Promise<TypeId<"source">> {
  await preparePartitionWrite(db, userId, partitionKey);
  const externalId = partitionKey
    ? `${ROLLUP_EXTERNAL_ID}:${partitionKey}`
    : ROLLUP_EXTERNAL_ID;
  const [inserted] = await db
    .insert(sources)
    .values({
      userId,
      partitionKey,
      type: "rollup",
      externalId,
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
        partitionKey === undefined
          ? isNull(sources.partitionKey)
          : eq(sources.partitionKey, partitionKey),
        eq(sources.type, "rollup"),
        eq(sources.externalId, externalId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`Failed to ensure rollup source for user ${userId}`);
  }
  return existing.id;
}
