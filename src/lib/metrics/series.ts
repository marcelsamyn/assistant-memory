/** Bucketed metric series reads. Common aliases: time series, metric chart data. */
import { and, eq, inArray, sql } from "drizzle-orm";
import { metricDefinitions, metricObservations } from "~/db/schema";
import {
  type GetMetricSeriesRequest,
  type GetMetricSeriesResponse,
  type MetricSeriesAggregation,
  type MetricSeriesBucket,
} from "~/lib/schemas/metric-read";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

const RAW_SERIES_ROW_LIMIT = 5_000;

function bucketDateTrunc(bucket: Exclude<MetricSeriesBucket, "none">) {
  switch (bucket) {
    case "hour":
      return sql`'hour'`;
    case "day":
      return sql`'day'`;
    case "week":
      return sql`'week'`;
    case "month":
      return sql`'month'`;
    default: {
      const exhaustive: never = bucket;
      return exhaustive;
    }
  }
}

function aggregateValue(agg: MetricSeriesAggregation) {
  switch (agg) {
    case "avg":
      return sql<string>`avg(${metricObservations.value}::numeric)`;
    case "sum":
      return sql<string>`sum(${metricObservations.value}::numeric)`;
    case "min":
      return sql<string>`min(${metricObservations.value}::numeric)`;
    case "max":
      return sql<string>`max(${metricObservations.value}::numeric)`;
    case "p50":
      return sql<string>`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${metricObservations.value}::numeric)`;
    case "p90":
      return sql<string>`percentile_cont(0.9) WITHIN GROUP (ORDER BY ${metricObservations.value}::numeric)`;
    default: {
      const exhaustive: never = agg;
      return exhaustive;
    }
  }
}

async function fetchMetricAggregationHints(
  userId: string,
  metricIds: TypeId<"metric_definition">[],
): Promise<Map<TypeId<"metric_definition">, MetricSeriesAggregation>> {
  const db = await useDatabase();
  const rows = await db
    .select({
      id: metricDefinitions.id,
      aggregationHint: metricDefinitions.aggregationHint,
    })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        inArray(metricDefinitions.id, metricIds),
      ),
    );

  return new Map(rows.map((row) => [row.id, row.aggregationHint]));
}

/** Return raw or bucketed points for the requested metrics over a UTC range. */
export async function getMetricSeries({
  userId,
  metricIds,
  from,
  to,
  bucket,
  agg,
}: GetMetricSeriesRequest): Promise<GetMetricSeriesResponse> {
  const db = await useDatabase();
  const aggregationHints = await fetchMetricAggregationHints(userId, metricIds);
  const requestedSeries = metricIds.map((metricId) => ({
    metricId,
    points: [],
  }));
  if (aggregationHints.size === 0) {
    return { series: requestedSeries };
  }

  if (bucket === "none") {
    const series = await Promise.all(
      metricIds.map(async (metricId) => {
        if (!aggregationHints.has(metricId)) return { metricId, points: [] };
        const rows = await db
          .select({
            t: metricObservations.occurredAt,
            value: metricObservations.value,
          })
          .from(metricObservations)
          .where(
            and(
              eq(metricObservations.userId, userId),
              eq(metricObservations.metricDefinitionId, metricId),
              sql`${metricObservations.occurredAt} >= ${from}`,
              sql`${metricObservations.occurredAt} <= ${to}`,
            ),
          )
          .orderBy(metricObservations.occurredAt)
          .limit(RAW_SERIES_ROW_LIMIT + 1);

        const truncated = rows.length > RAW_SERIES_ROW_LIMIT;
        return {
          metricId,
          points: rows
            .slice(0, RAW_SERIES_ROW_LIMIT)
            .map((row) => ({ t: row.t, value: Number(row.value) })),
          ...(truncated ? { truncated } : {}),
        };
      }),
    );

    return { series };
  }

  const bucketSql = bucketDateTrunc(bucket);
  const series = await Promise.all(
    metricIds.map(async (metricId) => {
      const metricAgg = agg ?? aggregationHints.get(metricId);
      if (metricAgg === undefined) return { metricId, points: [] };
      const bucketExpression = sql<Date>`date_trunc(${bucketSql}, ${metricObservations.occurredAt})`;
      const rows = await db
        .select({
          t: bucketExpression,
          value: aggregateValue(metricAgg),
        })
        .from(metricObservations)
        .where(
          and(
            eq(metricObservations.userId, userId),
            eq(metricObservations.metricDefinitionId, metricId),
            sql`${metricObservations.occurredAt} >= ${from}`,
            sql`${metricObservations.occurredAt} <= ${to}`,
          ),
        )
        .groupBy(bucketExpression)
        .orderBy(bucketExpression);

      return {
        metricId,
        points: rows.map((row) => ({ t: row.t, value: Number(row.value) })),
      };
    }),
  );

  return { series };
}
