import { and, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sourceTombstones, sources } from "~/db/schema";
import {
  PartitionAccessError,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { SourceType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

export interface MetricSourceInput {
  userId: string;
  partitionKey?: ContextPartitionKey | undefined;
  externalId: string;
  timestamp?: Date | undefined;
  metadata?: Record<string, unknown> | undefined;
}

async function upsertMetricSource(
  db: DrizzleDB,
  type: Extract<SourceType, "metric_push" | "metric_manual">,
  input: MetricSourceInput,
): Promise<TypeId<"source">> {
  const lastIngestedAt = input.timestamp ?? new Date();
  await preparePartitionWrite(db, input.userId, input.partitionKey);
  const [inserted] = await db
    .insert(sources)
    .values({
      userId: input.userId,
      partitionKey: input.partitionKey,
      type,
      externalId: input.externalId,
      scope: "personal",
      metadata: input.metadata ?? {},
      lastIngestedAt,
      status: "completed",
    })
    .onConflictDoUpdate({
      target: [sources.userId, sources.type, sources.externalId],
      set: {
        metadata: input.metadata ?? {},
        lastIngestedAt,
        status: "completed",
      },
      setWhere: sql`${sources.deletedAt} IS NULL AND NOT EXISTS (
        SELECT 1
        FROM ${sourceTombstones}
        WHERE ${sourceTombstones.userId} = ${input.userId}
          AND ${sourceTombstones.sourceId} = ${sources.id}
      ) AND ${
        input.partitionKey === undefined
          ? isNull(sources.partitionKey)
          : eq(sources.partitionKey, input.partitionKey)
      }`,
    })
    .returning({ id: sources.id });

  if (inserted) return inserted.id;

  const [existing] = await db
    .select({
      id: sources.id,
      deletedAt: sources.deletedAt,
      partitionKey: sources.partitionKey,
    })
    .from(sources)
    .where(
      and(
        eq(sources.userId, input.userId),
        eq(sources.type, type),
        eq(sources.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Failed to upsert metric source");
  if (existing.partitionKey !== (input.partitionKey ?? null)) {
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      "Metric source belongs to a different memory partition",
    );
  }
  const [tombstone] = await db
    .select({ sourceId: sourceTombstones.sourceId })
    .from(sourceTombstones)
    .where(
      and(
        eq(sourceTombstones.userId, input.userId),
        eq(sourceTombstones.sourceId, existing.id),
      ),
    )
    .limit(1);
  if (existing.deletedAt !== null || tombstone) {
    throw new PartitionAccessError(
      "SOURCE_TOMBSTONED",
      "A tombstoned metric source must be replaced by a fresh source identity",
    );
  }
  return existing.id;
}

export async function upsertMetricPushSource(
  db: DrizzleDB,
  input: MetricSourceInput,
): Promise<TypeId<"source">> {
  return upsertMetricSource(db, "metric_push", input);
}

export async function upsertMetricManualSource(
  db: DrizzleDB,
  input: MetricSourceInput,
): Promise<TypeId<"source">> {
  return upsertMetricSource(db, "metric_manual", input);
}
