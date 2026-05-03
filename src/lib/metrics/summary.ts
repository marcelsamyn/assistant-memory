/** Single-metric summary reads. Common aliases: metric latest, metric rollup. */
import { and, eq, sql } from "drizzle-orm";
import { metricDefinitions, metricObservations } from "~/db/schema";
import {
  type GetMetricSummaryRequest,
  type GetMetricSummaryResponse,
} from "~/lib/schemas/metric-read";
import type { MetricAggregationHint } from "~/lib/schemas/metric-write";
import { useDatabase } from "~/utils/db";

interface SummaryWindow {
  avg: number;
  min: number;
  max: number;
  count: number;
  sum: number;
}

type PublicSummaryWindow = Omit<SummaryWindow, "sum">;

function numberOrNull(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function toPublicWindow(
  window: SummaryWindow | null,
): PublicSummaryWindow | null {
  if (window === null) return null;
  return {
    avg: window.avg,
    min: window.min,
    max: window.max,
    count: window.count,
  };
}

function trendValue(
  window: SummaryWindow,
  aggregationHint: MetricAggregationHint,
): number {
  switch (aggregationHint) {
    case "avg":
      return window.avg;
    case "sum":
      return window.sum;
    case "min":
      return window.min;
    case "max":
      return window.max;
  }
}

function compareTrend(
  recent: SummaryWindow | null,
  baseline: SummaryWindow | null,
  aggregationHint: MetricAggregationHint,
): "up" | "down" | "flat" | null {
  if (recent === null || baseline === null) return null;
  const recentValue = trendValue(recent, aggregationHint);
  const baselineValue = trendValue(baseline, aggregationHint);
  if (baselineValue === 0) return recentValue === 0 ? "flat" : "up";

  const delta = (recentValue - baselineValue) / Math.abs(baselineValue);
  if (Math.abs(delta) <= 0.01) return "flat";
  return delta > 0 ? "up" : "down";
}

/** Return latest reading, 7d/30d/90d stats, and coarse trend for one metric. */
export async function getMetricSummary({
  userId,
  metricId,
}: GetMetricSummaryRequest): Promise<GetMetricSummaryResponse> {
  const db = await useDatabase();
  const [definition] = await db
    .select({
      id: metricDefinitions.id,
      aggregationHint: metricDefinitions.aggregationHint,
    })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        eq(metricDefinitions.id, metricId),
      ),
    )
    .limit(1);

  if (definition === undefined) {
    return {
      metricId,
      latest: null,
      windows: {
        "7d": null,
        "30d": null,
        "90d": null,
      },
      trend: null,
    };
  }

  const [latestRow] = await db
    .select({
      value: metricObservations.value,
      occurredAt: metricObservations.occurredAt,
    })
    .from(metricObservations)
    .where(
      and(
        eq(metricObservations.userId, userId),
        eq(metricObservations.metricDefinitionId, metricId),
      ),
    )
    .orderBy(sql`${metricObservations.occurredAt} DESC`)
    .limit(1);

  const now = new Date();
  const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const last90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const readWindow = async (since: Date): Promise<SummaryWindow | null> => {
    const [row] = await db
      .select({
        count: sql<number>`count(${metricObservations.id})`,
        avg: sql<string | null>`avg(${metricObservations.value}::numeric)`,
        min: sql<string | null>`min(${metricObservations.value}::numeric)`,
        max: sql<string | null>`max(${metricObservations.value}::numeric)`,
        sum: sql<string | null>`sum(${metricObservations.value}::numeric)`,
      })
      .from(metricObservations)
      .where(
        and(
          eq(metricObservations.userId, userId),
          eq(metricObservations.metricDefinitionId, metricId),
          sql`${metricObservations.occurredAt} >= ${since}`,
        ),
      );

    if (row === undefined || row.count === 0) return null;
    return {
      count: Number(row.count),
      avg: numberOrNull(row.avg) ?? 0,
      min: numberOrNull(row.min) ?? 0,
      max: numberOrNull(row.max) ?? 0,
      sum: numberOrNull(row.sum) ?? 0,
    };
  };

  const [last7dWindow, last30dWindow, last90dWindow] = await Promise.all([
    readWindow(last7d),
    readWindow(last30d),
    readWindow(last90d),
  ]);

  return {
    metricId,
    latest:
      latestRow === undefined
        ? null
        : { value: Number(latestRow.value), occurredAt: latestRow.occurredAt },
    windows: {
      "7d": toPublicWindow(last7dWindow),
      "30d": toPublicWindow(last30dWindow),
      "90d": toPublicWindow(last90dWindow),
    },
    trend: compareTrend(
      last30dWindow,
      last90dWindow,
      definition.aggregationHint,
    ),
  };
}
