import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodes, nodeMetadata, sourceLinks } from "~/db/schema";
import { normalizeLabel } from "~/lib/label";
import type { TypeId } from "~/types/typeid";

export interface MetricEventNodeInput {
  userId: string;
  metricEventKey: string;
  label: string;
  occurredAt: Date;
  sourceId?: TypeId<"source"> | undefined;
  description?: string | undefined;
}

export function metricEventAdditionalData(
  metricEventKey: string,
  occurredAt: Date,
): Record<string, unknown> {
  return {
    metricEventKey,
    occurredAt: occurredAt.toISOString(),
  };
}

/** Create or reuse an Event node keyed by nodeMetadata.additionalData.metricEventKey. */
export async function ensureMetricEventNode(
  db: DrizzleDB,
  input: MetricEventNodeInput,
): Promise<TypeId<"node">> {
  const [existing] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, input.userId),
        eq(nodes.nodeType, "Event"),
        sql`${nodeMetadata.additionalData} ->> 'metricEventKey' = ${input.metricEventKey}`,
      ),
    )
    .limit(1);

  if (existing) {
    if (input.sourceId !== undefined) {
      await db
        .insert(sourceLinks)
        .values({ sourceId: input.sourceId, nodeId: existing.id })
        .onConflictDoNothing();
    }
    return existing.id;
  }

  const [inserted] = await db
    .insert(nodes)
    .values({ userId: input.userId, nodeType: "Event" })
    .returning({ id: nodes.id });
  if (!inserted) throw new Error("Failed to create metric event node");

  await db.insert(nodeMetadata).values({
    nodeId: inserted.id,
    label: input.label,
    canonicalLabel: normalizeLabel(input.label),
    description: input.description ?? null,
    additionalData: metricEventAdditionalData(
      input.metricEventKey,
      input.occurredAt,
    ),
  });

  const { generateAndInsertNodeEmbeddings } = await import(
    "~/lib/embeddings-util"
  );
  await generateAndInsertNodeEmbeddings(db, [
    {
      id: inserted.id,
      label: input.label,
      description: input.description ?? null,
    },
  ]);

  if (input.sourceId !== undefined) {
    await db
      .insert(sourceLinks)
      .values({ sourceId: input.sourceId, nodeId: inserted.id })
      .onConflictDoNothing();
  }

  return inserted.id;
}
