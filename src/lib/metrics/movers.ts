/**
 * Metric "movers" — latest value plus recent delta/direction per metric.
 *
 * Built on the batched `getMetricSummaries` read (latest + 7d/30d/90d
 * windows for all of a user's metrics in one round-trip) joined with
 * `listMetrics` for slug/label/unit, so a digest/dashboard "what moved"
 * panel needs no per-metric fan-out. The value added here over raw
 * summaries is the delta/direction and the largest-mover ranking.
 *
 * Common aliases: metric movers, dashboard movers, metric deltas.
 */
import { listMetrics } from "./list";
import { getMetricSummaries } from "./summary";
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

function pickBaseline(
  summary: GetMetricSummaryResponse,
): { window: MetricMoverWindow; avg: number } | null {
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
  const [{ summaries }, definitions] = await Promise.all([
    getMetricSummaries({
      userId,
      ...(metricIds !== undefined
        ? { metricIds }
        : { filter: { active: true } }),
    }),
    listMetrics({ userId, filter: { active: true } }),
  ]);

  const definitionById = new Map(
    definitions.map((definition) => [definition.id, definition]),
  );

  const movers: MetricMover[] = [];
  for (const summary of summaries) {
    const definition = definitionById.get(summary.metricId);
    // Skip metrics without a (still-active) definition or any reading — a
    // metric with no observations isn't a "mover".
    if (definition === undefined || summary.latest === null) continue;
    movers.push(toMover(definition, summary));
  }

  movers.sort((a, b) => moverMagnitude(b) - moverMagnitude(a));
  return limit === undefined ? movers : movers.slice(0, limit);
}
