import { and, cosineDistance, desc, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  metricDefinitionEmbeddings,
  metricDefinitions,
  metricObservations,
} from "~/db/schema";
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
import { useDatabase } from "~/utils/db";
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

export interface UpdateMetricDefinitionPatch {
  slug?: string | undefined;
  label?: string | undefined;
  description?: string | undefined;
  unit?: string | undefined;
  aggregationHint?: "avg" | "sum" | "min" | "max" | undefined;
  validRangeMin?: number | null | undefined;
  validRangeMax?: number | null | undefined;
  needsReview?: boolean | undefined;
}

export class MetricDefinitionNotFoundError extends Error {
  readonly metricDefinitionId: TypeId<"metric_definition">;
  constructor(metricDefinitionId: TypeId<"metric_definition">) {
    super(`Metric definition not found: ${metricDefinitionId}`);
    this.name = "MetricDefinitionNotFoundError";
    this.metricDefinitionId = metricDefinitionId;
  }
}

export class MetricDefinitionSlugConflictError extends Error {
  readonly slug: string;
  constructor(slug: string) {
    super(`Metric definition slug already in use: ${slug}`);
    this.name = "MetricDefinitionSlugConflictError";
    this.slug = slug;
  }
}

export class MetricDefinitionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricDefinitionValidationError";
  }
}

/**
 * Patch a metric definition. When label/description change, regenerates the
 * embedding too — the new embedding is computed up-front, then the row update
 * and embedding delete+insert run in a single transaction so we never persist
 * an updated definition without a matching embedding.
 */
export async function updateMetricDefinition(
  userId: string,
  metricDefinitionId: TypeId<"metric_definition">,
  patch: UpdateMetricDefinitionPatch,
): Promise<MetricDefinition> {
  const db = await useDatabase();

  const [existing] = await db
    .select()
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        eq(metricDefinitions.id, metricDefinitionId),
      ),
    )
    .limit(1);

  if (!existing) throw new MetricDefinitionNotFoundError(metricDefinitionId);

  const nextLabel = patch.label ?? existing.label;
  const nextDescription = patch.description ?? existing.description;
  const nextUnit = patch.unit ?? existing.unit;
  const nextAggregationHint = patch.aggregationHint ?? existing.aggregationHint;
  const nextSlug = patch.slug ?? existing.slug;
  const nextValidRange = validateUpdatedRange(existing, patch);

  const embeddingTextChanged =
    nextLabel !== existing.label || nextDescription !== existing.description;
  // Compute the new embedding *before* the transaction so a failure in the
  // embedding service can't leave the row updated with a stale vector.
  const newEmbedding = embeddingTextChanged
    ? await generateMetricDefinitionEmbedding({
        slug: nextSlug,
        label: nextLabel,
        description: nextDescription,
        unit: nextUnit,
        aggregationHint: nextAggregationHint,
      })
    : null;

  const updateValues: Partial<typeof metricDefinitions.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (patch.slug !== undefined) updateValues.slug = patch.slug;
  if (patch.label !== undefined) updateValues.label = patch.label;
  if (patch.description !== undefined)
    updateValues.description = patch.description;
  if (patch.unit !== undefined) updateValues.unit = patch.unit;
  if (patch.aggregationHint !== undefined)
    updateValues.aggregationHint = patch.aggregationHint;
  if (patch.validRangeMin !== undefined)
    updateValues.validRangeMin = nextValidRange.min;
  if (patch.validRangeMax !== undefined)
    updateValues.validRangeMax = nextValidRange.max;
  if (patch.needsReview !== undefined)
    updateValues.needsReview = patch.needsReview;

  const updated = await db.transaction(async (tx) => {
    if (patch.slug !== undefined && patch.slug !== existing.slug) {
      const [conflict] = await tx
        .select({ id: metricDefinitions.id })
        .from(metricDefinitions)
        .where(
          and(
            eq(metricDefinitions.userId, userId),
            eq(metricDefinitions.slug, patch.slug),
          ),
        )
        .limit(1);
      if (conflict) throw new MetricDefinitionSlugConflictError(patch.slug);
    }

    const [row] = await tx
      .update(metricDefinitions)
      .set(updateValues)
      .where(
        and(
          eq(metricDefinitions.userId, userId),
          eq(metricDefinitions.id, metricDefinitionId),
        ),
      )
      .returning();

    if (!row) throw new MetricDefinitionNotFoundError(metricDefinitionId);

    if (embeddingTextChanged && newEmbedding) {
      await tx
        .delete(metricDefinitionEmbeddings)
        .where(
          eq(metricDefinitionEmbeddings.metricDefinitionId, metricDefinitionId),
        );
      await insertMetricDefinitionEmbedding(
        tx,
        metricDefinitionId,
        newEmbedding,
      );
    }

    return row;
  });

  return parseDefinition(updated);
}

function validateUpdatedRange(
  existing: MetricDefinitionRow,
  patch: UpdateMetricDefinitionPatch,
): { min: string | null; max: string | null } {
  const min =
    patch.validRangeMin === undefined
      ? existing.validRangeMin
      : patch.validRangeMin === null
        ? null
        : patch.validRangeMin.toString();
  const max =
    patch.validRangeMax === undefined
      ? existing.validRangeMax
      : patch.validRangeMax === null
        ? null
        : patch.validRangeMax.toString();
  if (min !== null && max !== null && Number(min) > Number(max)) {
    throw new MetricDefinitionValidationError(
      "validRangeMin must be less than or equal to validRangeMax",
    );
  }
  return { min, max };
}

/** Delete a metric definition (and its observations + embedding via FK cascade). */
export async function deleteMetricDefinition(
  userId: string,
  metricDefinitionId: TypeId<"metric_definition">,
): Promise<{ deletedObservationCount: number }> {
  const db = await useDatabase();

  const [observationCountRow] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.userId, userId),
        eq(metricObservations.metricDefinitionId, metricDefinitionId),
      ),
    );
  const deletedObservationCount = observationCountRow?.value ?? 0;

  const deletedRows = await db
    .delete(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        eq(metricDefinitions.id, metricDefinitionId),
      ),
    )
    .returning({ id: metricDefinitions.id });

  if (deletedRows.length === 0) {
    throw new MetricDefinitionNotFoundError(metricDefinitionId);
  }

  return { deletedObservationCount };
}
