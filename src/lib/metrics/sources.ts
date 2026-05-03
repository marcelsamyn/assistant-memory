import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import type { SourceType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

export interface MetricSourceInput {
  userId: string;
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
  const [inserted] = await db
    .insert(sources)
    .values({
      userId: input.userId,
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
        deletedAt: null,
      },
    })
    .returning({ id: sources.id });

  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: sources.id })
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
