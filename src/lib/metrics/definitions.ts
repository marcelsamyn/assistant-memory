import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { metricDefinitionEmbeddings, metricDefinitions } from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import { HIGH_SIMILARITY, MID_SIMILARITY } from "~/lib/metrics/constants";
import { createNode } from "~/lib/node";
import {
  type MetricDefinition,
  type ProposedMetricDefinition,
  metricDefinitionSchema,
  proposedMetricDefinitionSchema,
} from "~/lib/schemas/metric-definition";
import type { TypeId } from "~/types/typeid";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

type MetricDefinitionRow = typeof metricDefinitions.$inferSelect;

export interface MetricDefinitionResolution {
  definition: MetricDefinition;
  created: boolean;
  reusedBy: "slug" | "similarity" | null;
  similarity: number | null;
}

interface SimilarMetricDefinition {
  definition: MetricDefinitionRow;
  similarity: number;
}

export function metricDefinitionEmbeddingText(
  metric: Pick<ProposedMetricDefinition, "label" | "description">,
): string {
  return `${metric.label}\n${metric.description}`;
}

function parseDefinition(row: MetricDefinitionRow): MetricDefinition {
  return metricDefinitionSchema.parse(row);
}

async function generateMetricDefinitionEmbedding(
  metric: ProposedMetricDefinition,
): Promise<number[] | null> {
  if (shouldSkipEmbeddingPersistence()) return null;

  const response = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [metricDefinitionEmbeddingText(metric)],
    truncate: true,
  });
  return response.data[0]?.embedding ?? null;
}

async function findMostSimilarMetricDefinition(
  db: DrizzleDB,
  userId: string,
  embedding: number[],
): Promise<SimilarMetricDefinition | null> {
  const similarity = sql<number>`1 - (${cosineDistance(
    metricDefinitionEmbeddings.embedding,
    embedding,
  )})`;

  const [row] = await db
    .select({
      definition: metricDefinitions,
      similarity,
    })
    .from(metricDefinitionEmbeddings)
    .innerJoin(
      metricDefinitions,
      eq(metricDefinitionEmbeddings.metricDefinitionId, metricDefinitions.id),
    )
    .where(
      and(eq(metricDefinitions.userId, userId), sql`${similarity} IS NOT NULL`),
    )
    .orderBy(desc(similarity))
    .limit(1);

  return row ?? null;
}

async function insertMetricDefinition(
  db: DrizzleDB,
  userId: string,
  metric: ProposedMetricDefinition,
  needsReview: boolean,
  reviewTaskNodeId?: TypeId<"node"> | undefined,
): Promise<MetricDefinitionRow> {
  const [inserted] = await db
    .insert(metricDefinitions)
    .values({
      userId,
      slug: metric.slug,
      label: metric.label,
      description: metric.description,
      unit: metric.unit,
      aggregationHint: metric.aggregationHint,
      validRangeMin: metric.validRangeMin?.toString(),
      validRangeMax: metric.validRangeMax?.toString(),
      needsReview,
      reviewTaskNodeId,
    })
    .returning();
  if (!inserted) throw new Error("Failed to create metric definition");
  return inserted;
}

async function insertMetricDefinitionEmbedding(
  db: DrizzleDB,
  metricDefinitionId: TypeId<"metric_definition">,
  embedding: number[] | null,
): Promise<void> {
  if (!embedding) return;

  await db.insert(metricDefinitionEmbeddings).values({
    metricDefinitionId,
    embedding,
    modelName: "jina-embeddings-v3",
  });
}

async function createReviewTask(
  userId: string,
  proposed: ProposedMetricDefinition,
  existing: Pick<MetricDefinitionRow, "label" | "slug">,
): Promise<TypeId<"node">> {
  const task = await createNode(
    userId,
    "Task",
    `Review proposed metric: '${proposed.label}'`,
    `Possible duplicate of '${existing.label}' (${existing.slug}). Proposed slug: ${proposed.slug}.`,
    [
      {
        predicate: "HAS_TASK_STATUS",
        objectValue: "pending",
        statement: `Review proposed metric '${proposed.label}' for possible duplication.`,
        assertedByKind: "system",
      },
    ],
  );
  return task.id;
}

/** Resolve a proposed metric by exact slug, high-similarity reuse, or creation. */
export async function resolveMetricDefinition(
  db: DrizzleDB,
  userId: string,
  proposedMetric: ProposedMetricDefinition,
): Promise<MetricDefinitionResolution> {
  const metric = proposedMetricDefinitionSchema.parse(proposedMetric);
  const [exact] = await db
    .select()
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        eq(metricDefinitions.slug, metric.slug),
      ),
    )
    .limit(1);

  if (exact) {
    return {
      definition: parseDefinition(exact),
      created: false,
      reusedBy: "slug",
      similarity: null,
    };
  }

  const embedding = await generateMetricDefinitionEmbedding(metric);
  const similar = embedding
    ? await findMostSimilarMetricDefinition(db, userId, embedding)
    : null;

  if (similar && similar.similarity >= HIGH_SIMILARITY) {
    return {
      definition: parseDefinition(similar.definition),
      created: false,
      reusedBy: "similarity",
      similarity: similar.similarity,
    };
  }

  const needsReview = similar !== null && similar.similarity >= MID_SIMILARITY;
  const inserted = await insertMetricDefinition(
    db,
    userId,
    metric,
    needsReview,
  );
  await insertMetricDefinitionEmbedding(db, inserted.id, embedding);

  if (!needsReview || !similar) {
    return {
      definition: parseDefinition(inserted),
      created: true,
      reusedBy: null,
      similarity: similar?.similarity ?? null,
    };
  }

  const reviewTaskNodeId = await createReviewTask(
    userId,
    metric,
    similar.definition,
  );
  const [updated] = await db
    .update(metricDefinitions)
    .set({ reviewTaskNodeId, updatedAt: new Date() })
    .where(eq(metricDefinitions.id, inserted.id))
    .returning();
  if (!updated) throw new Error("Failed to attach metric review task");

  return {
    definition: parseDefinition(updated),
    created: true,
    reusedBy: null,
    similarity: similar.similarity,
  };
}

export async function getMetricDefinitionBySlug(
  db: DrizzleDB,
  userId: string,
  slug: string,
): Promise<MetricDefinition | null> {
  const [row] = await db
    .select()
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        eq(metricDefinitions.slug, slug),
      ),
    )
    .limit(1);

  return row ? parseDefinition(row) : null;
}
