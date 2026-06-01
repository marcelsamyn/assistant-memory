import { getMetricMovers } from "./movers";
import { describe, expect, it, vi } from "vitest";
import type { GetMetricSummaryResponse } from "~/lib/schemas/metric-read";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  getMetricSummaries: vi.fn(),
  listMetrics: vi.fn(),
}));

vi.mock("./summary", () => ({ getMetricSummaries: mocks.getMetricSummaries }));
vi.mock("./list", () => ({ listMetrics: mocks.listMetrics }));

function definition(id: string, slug: string) {
  return {
    id,
    slug,
    label: slug,
    description: slug,
    unit: "u",
    aggregationHint: "avg" as const,
    validRange: { min: null, max: null },
    needsReview: false,
    reviewTaskNodeId: null,
    stats: {
      observationCount: 5,
      firstAt: null,
      latestAt: null,
      latestValue: null,
    },
  };
}

function summary(
  metricId: string,
  latest: number | null,
  avg7d: number | null,
  avg30d: number | null = null,
  avg90d: number | null = null,
): GetMetricSummaryResponse {
  const window = (value: number | null) =>
    value === null ? null : { avg: value, min: value, max: value, count: 3 };
  return {
    metricId: metricId as GetMetricSummaryResponse["metricId"],
    latest: latest === null ? null : { value: latest, occurredAt: new Date() },
    windows: {
      "7d": window(avg7d),
      "30d": window(avg30d),
      "90d": window(avg90d),
    },
    trend: null,
  };
}

function arrange(
  defs: ReturnType<typeof definition>[],
  summaries: GetMetricSummaryResponse[],
) {
  mocks.listMetrics.mockResolvedValue(defs);
  mocks.getMetricSummaries.mockResolvedValue({ summaries });
}

describe("getMetricMovers", () => {
  it("computes delta/direction against the first non-empty window and ranks by magnitude", async () => {
    const small = newTypeId("metric_definition");
    const big = newTypeId("metric_definition");
    const flat = newTypeId("metric_definition");
    arrange(
      [
        definition(small, "small"),
        definition(big, "big"),
        definition(flat, "flat"),
      ],
      [
        summary(small, 105, 100), // +5% → up
        summary(big, 200, 100), // +100% → up, largest mover
        summary(flat, 100, 100), // 0% → flat
      ],
    );

    const movers = await getMetricMovers({ userId: "user_movers" });

    expect(movers.map((m) => m.slug)).toEqual(["big", "small", "flat"]);
    expect(movers[0]).toMatchObject({
      slug: "big",
      latestValue: 200,
      delta: 100,
      direction: "up",
      window: "7d",
    });
    expect(movers[2]).toMatchObject({ direction: "flat", delta: 0 });
    expect(mocks.getMetricSummaries).toHaveBeenCalledWith({
      userId: "user_movers",
      filter: { active: true },
    });
  });

  it("falls back to the 30d/90d window when 7d is empty", async () => {
    const id = newTypeId("metric_definition");
    arrange([definition(id, "q")], [summary(id, 60, null, null, 50)]);

    const [mover] = await getMetricMovers({ userId: "user_movers" });

    expect(mover).toMatchObject({ delta: 10, direction: "up", window: "90d" });
  });

  it("drops metrics with no readings and nulls movement when no window has data", async () => {
    const stale = newTypeId("metric_definition");
    const empty = newTypeId("metric_definition");
    arrange(
      [definition(stale, "stale"), definition(empty, "empty")],
      [
        summary(stale, 50, null, null, null), // has a latest, but no recent window
        summary(empty, null, null, null, null), // no readings → excluded
      ],
    );

    const movers = await getMetricMovers({ userId: "user_movers" });

    expect(movers).toHaveLength(1);
    expect(movers[0]).toMatchObject({
      slug: "stale",
      latestValue: 50,
      delta: null,
      direction: null,
      window: null,
    });
  });

  it("applies the limit after ranking", async () => {
    const a = newTypeId("metric_definition");
    const b = newTypeId("metric_definition");
    arrange(
      [definition(a, "a"), definition(b, "b")],
      [summary(a, 101, 100), summary(b, 150, 100)],
    );

    const movers = await getMetricMovers({ userId: "user_movers", limit: 1 });

    expect(movers).toHaveLength(1);
    expect(movers[0]!.slug).toBe("b");
  });
});
