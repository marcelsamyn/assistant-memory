/** Metric definition listing with observation stats. Common aliases: metrics registry, metric catalog. */
import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  max,
  min,
  or,
  sql,
} from "drizzle-orm";
import { metricDefinitions, metricObservations } from "~/db/schema";
import {
  type ListMetricsRequest,
  type MetricDefinitionWithStats,
} from "~/lib/schemas/metric-read";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** Return metric definitions for a user, optionally filtered for UI pickers and dashboards. */
export async function listMetrics({
  userId,
  filter,
}: ListMetricsRequest): Promise<MetricDefinitionWithStats[]> {
  const db = await useDatabase();
  const definitions = await db
    .select()
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        filter?.needsReview === undefined
          ? undefined
          : eq(metricDefinitions.needsReview, filter.needsReview),
        filter?.search === undefined
          ? undefined
          : or(
              ilike(metricDefinitions.slug, `%${filter.search}%`),
              ilike(metricDefinitions.label, `%${filter.search}%`),
              ilike(metricDefinitions.description, `%${filter.search}%`),
            ),
      ),
    )
    .orderBy(asc(metricDefinitions.label), asc(metricDefinitions.slug));

  const definitionIds = definitions.map((definition) => definition.id);
  if (definitionIds.length === 0) return [];

  const statsRows = await db
    .select({
      metricDefinitionId: metricObservations.metricDefinitionId,
      observationCount: count(metricObservations.id),
      firstAt: min(metricObservations.occurredAt),
      latestAt: max(metricObservations.occurredAt),
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.userId, userId),
        inArray(metricObservations.metricDefinitionId, definitionIds),
      ),
    )
    .groupBy(metricObservations.metricDefinitionId);

  const latestRows = await db
    .select({
      metricDefinitionId: metricObservations.metricDefinitionId,
      value: metricObservations.value,
      occurredAt: metricObservations.occurredAt,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.userId, userId),
        inArray(metricObservations.metricDefinitionId, definitionIds),
      ),
    )
    .orderBy(
      metricObservations.metricDefinitionId,
      sql`${metricObservations.occurredAt} DESC`,
    );

  const statsByDefinitionId = new Map(
    statsRows.map((row) => [row.metricDefinitionId, row]),
  );
  const latestByDefinitionId = latestRows.reduce(
    (latest, row) =>
      latest.has(row.metricDefinitionId)
        ? latest
        : latest.set(row.metricDefinitionId, row),
    new Map<
      TypeId<"metric_definition">,
      { value: string | number; occurredAt: Date }
    >(),
  );

  return definitions
    .map((definition) => {
      const stats = statsByDefinitionId.get(definition.id);
      const latest = latestByDefinitionId.get(definition.id);
      return {
        id: definition.id,
        slug: definition.slug,
        label: definition.label,
        description: definition.description,
        unit: definition.unit,
        aggregationHint: definition.aggregationHint,
        validRange: {
          min: numberOrNull(definition.validRangeMin),
          max: numberOrNull(definition.validRangeMax),
        },
        needsReview: definition.needsReview,
        reviewTaskNodeId: definition.reviewTaskNodeId,
        stats: {
          observationCount: stats?.observationCount ?? 0,
          firstAt: stats?.firstAt ?? null,
          latestAt: stats?.latestAt ?? null,
          latestValue: latest === undefined ? null : Number(latest.value),
        },
      };
    })
    .filter((metric) =>
      filter?.active === undefined
        ? true
        : filter.active === metric.stats.observationCount > 0,
    );
}
