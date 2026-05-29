/**
 * Metric "movers" — latest value plus recent delta/direction per metric,
 * vectorized over a user's active metrics. Reuses the single-metric
 * `getMetricSummary` per definition so the windowing/aggregation logic
 * stays in one place; the value here is the one-call rollup + ranking.
 *
 * Common aliases: metric movers, dashboard movers, metric deltas.
 */
import { listMetrics } from "./list";
import { getMetricSummary } from "./summary";
import {
  type GetMetricMoversRequest,
  type MetricMover,
  type MetricMoverWindow,
} from "~/lib/schemas/metric-movers";
import type {
  GetMetricSummaryResponse,
  MetricDefinitionWithStats,
} from "~/lib/schemas/metric-read";

const BASELINE_WINDOWS: readonly MetricMoverWindow[] = ["7d", "30d", "90d"];
const FLAT_EPSILON = 0.01;

interface Baseline {
  window: MetricMoverWindow;
  avg: number;
}

function pickBaseline(summary: GetMetricSummaryResponse): Baseline | null {
  for (const window of BASELINE_WINDOWS) {
    const stats = summary.windows[window];
    if (stats !== null) return { window, avg: stats.avg };
  }
  return null;
}

function directionOf(
  delta: number,
  baselineAvg: number,
): MetricMover["direction"] {
  if (baselineAvg === 0)
    return delta === 0 ? "flat" : delta > 0 ? "up" : "down";
  if (Math.abs(delta / baselineAvg) <= FLAT_EPSILON) return "flat";
  return delta > 0 ? "up" : "down";
}

function toMover(
  definition: MetricDefinitionWithStats,
  summary: GetMetricSummaryResponse,
): MetricMover {
  const latestValue = summary.latest?.value ?? null;
  const baseline = pickBaseline(summary);
  const identity = {
    metricId: definition.id,
    slug: definition.slug,
    label: definition.label,
    unit: definition.unit,
    latestValue,
  };

  if (latestValue === null || baseline === null) {
    return { ...identity, delta: null, direction: null, window: null };
  }

  const delta = latestValue - baseline.avg;
  return {
    ...identity,
    delta,
    direction: directionOf(delta, baseline.avg),
    window: baseline.window,
  };
}

/** Largest mover first: |delta| normalized by the baseline it moved from. */
function moverMagnitude(mover: MetricMover): number {
  if (mover.delta === null || mover.latestValue === null) return 0;
  const baselineAvg = Math.abs(mover.latestValue - mover.delta);
  return baselineAvg === 0
    ? Math.abs(mover.delta)
    : Math.abs(mover.delta) / baselineAvg;
}

/** Rank a user's active metrics by recent movement. */
export async function getMetricMovers({
  userId,
  metricIds,
  limit,
}: GetMetricMoversRequest): Promise<MetricMover[]> {
  const definitions = (
    await listMetrics({ userId, filter: { active: true } })
  ).filter(
    (definition) =>
      metricIds === undefined || metricIds.includes(definition.id),
  );

  const movers = await Promise.all(
    definitions.map(async (definition) =>
      toMover(
        definition,
        await getMetricSummary({ userId, metricId: definition.id }),
      ),
    ),
  );

  movers.sort((a, b) => moverMagnitude(b) - moverMagnitude(a));
  return limit === undefined ? movers : movers.slice(0, limit);
}
