/** Metric summary reads. Common aliases: metric latest, metric rollup, movers. */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { metricDefinitions, metricObservations } from "~/db/schema";
import {
  type GetMetricSummariesRequest,
  type GetMetricSummariesResponse,
  type GetMetricSummaryRequest,
  type GetMetricSummaryResponse,
} from "~/lib/schemas/metric-read";
import type { MetricAggregationHint } from "~/lib/schemas/metric-write";
import type { TypeId } from "~/types/typeid";
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

/** Summary for a metric with no resolvable definition or no observations. */
function emptySummary(
  metricId: TypeId<"metric_definition">,
): GetMetricSummaryResponse {
  return {
    metricId,
    latest: null,
    windows: { "7d": null, "30d": null, "90d": null },
    trend: null,
  };
}

/** Start of each rollup window, relative to `now`. */
function windowStarts(now: Date) {
  const day = 24 * 60 * 60 * 1000;
  return {
    "7d": new Date(now.getTime() - 7 * day),
    "30d": new Date(now.getTime() - 30 * day),
    "90d": new Date(now.getTime() - 90 * day),
  };
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
    return emptySummary(metricId);
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

  const starts = windowStarts(new Date());

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
    readWindow(starts["7d"]),
    readWindow(starts["30d"]),
    readWindow(starts["90d"]),
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

type MetricId = TypeId<"metric_definition">;

/**
 * Vectorized {@link getMetricSummary}: latest reading, 7d/30d/90d stats, and a
 * coarse trend for many metrics in a fixed number of queries (no per-metric
 * fan-out). Powers "metric movers" dashboards/digests.
 *
 * - `metricIds` omitted → every metric the user owns, ordered by label then
 *   slug, narrowed by `filter` (`active` = has any observation, `needsReview`).
 * - `metricIds` provided → exactly those metrics, in request order, with a
 *   null-filled summary for any id the user doesn't own (mirrors
 *   `getMetricSeries`). `filter` is ignored in this case — the explicit list
 *   is the selection.
 */
export async function getMetricSummaries({
  userId,
  metricIds,
  filter,
}: GetMetricSummariesRequest): Promise<GetMetricSummariesResponse> {
  const db = await useDatabase();

  const definitions = await db
    .select({
      id: metricDefinitions.id,
      aggregationHint: metricDefinitions.aggregationHint,
    })
    .from(metricDefinitions)
    .where(
      and(
        eq(metricDefinitions.userId, userId),
        metricIds === undefined
          ? undefined
          : inArray(metricDefinitions.id, metricIds),
        // Definition-level filters only apply to the "summarize all" mode.
        metricIds === undefined && filter?.needsReview !== undefined
          ? eq(metricDefinitions.needsReview, filter.needsReview)
          : undefined,
      ),
    )
    .orderBy(asc(metricDefinitions.label), asc(metricDefinitions.slug));

  const hintById = new Map<MetricId, MetricAggregationHint>(
    definitions.map((definition) => [
      definition.id,
      definition.aggregationHint,
    ]),
  );
  const definitionIds = definitions.map((definition) => definition.id);
  if (definitionIds.length === 0) {
    return {
      summaries: (metricIds ?? []).map((metricId) => emptySummary(metricId)),
    };
  }

  // When summarizing every metric (no explicit ids and no needsReview filter)
  // the candidate set IS all of the user's definitions, so `userId` alone
  // already scopes the observation reads — pass the (potentially large) id
  // array to `inArray` only when it actually narrows, to avoid the planner
  // overhead and bind-parameter limit of a redundant IN list.
  const definitionScope =
    metricIds !== undefined || filter?.needsReview !== undefined
      ? inArray(metricObservations.metricDefinitionId, definitionIds)
      : undefined;

  // DISTINCT ON pulls the freshest observation per metric in one pass, using
  // the (user_id, metric_definition_id, occurred_at DESC) index.
  const latestRows = await db
    .selectDistinctOn([metricObservations.metricDefinitionId], {
      metricDefinitionId: metricObservations.metricDefinitionId,
      value: metricObservations.value,
      occurredAt: metricObservations.occurredAt,
    })
    .from(metricObservations)
    .where(and(eq(metricObservations.userId, userId), definitionScope))
    .orderBy(
      metricObservations.metricDefinitionId,
      desc(metricObservations.occurredAt),
    );

  const readWindow = async (
    since: Date,
  ): Promise<Map<MetricId, SummaryWindow>> => {
    const rows = await db
      .select({
        metricDefinitionId: metricObservations.metricDefinitionId,
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
          definitionScope,
          sql`${metricObservations.occurredAt} >= ${since}`,
        ),
      )
      .groupBy(metricObservations.metricDefinitionId);

    return new Map(
      rows.map((row) => [
        row.metricDefinitionId,
        {
          count: Number(row.count),
          avg: numberOrNull(row.avg) ?? 0,
          min: numberOrNull(row.min) ?? 0,
          max: numberOrNull(row.max) ?? 0,
          sum: numberOrNull(row.sum) ?? 0,
        },
      ]),
    );
  };

  const latestById = new Map(
    latestRows.map((row) => [row.metricDefinitionId, row]),
  );
  const starts = windowStarts(new Date());
  const [win7, win30, win90] = await Promise.all([
    readWindow(starts["7d"]),
    readWindow(starts["30d"]),
    readWindow(starts["90d"]),
  ]);

  const buildSummary = (metricId: MetricId): GetMetricSummaryResponse => {
    const aggregationHint = hintById.get(metricId);
    if (aggregationHint === undefined) return emptySummary(metricId);
    const latest = latestById.get(metricId);
    const w7 = win7.get(metricId) ?? null;
    const w30 = win30.get(metricId) ?? null;
    const w90 = win90.get(metricId) ?? null;
    return {
      metricId,
      latest:
        latest === undefined
          ? null
          : { value: Number(latest.value), occurredAt: latest.occurredAt },
      windows: {
        "7d": toPublicWindow(w7),
        "30d": toPublicWindow(w30),
        "90d": toPublicWindow(w90),
      },
      trend: compareTrend(w30, w90, aggregationHint),
    };
  };

  if (metricIds !== undefined) {
    return { summaries: metricIds.map(buildSummary) };
  }

  const summaries = definitionIds.map(buildSummary);
  if (filter?.active === undefined) return { summaries };
  return {
    summaries: summaries.filter(
      (summary) => filter.active === (summary.latest !== null),
    ),
  };
}
