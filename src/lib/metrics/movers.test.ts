import { getMetricMovers } from "./movers";
import { describe, expect, it, vi } from "vitest";
import type { GetMetricSummaryResponse } from "~/lib/schemas/metric-read";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  listMetrics: vi.fn(),
  getMetricSummary: vi.fn(),
}));

vi.mock("./list", () => ({ listMetrics: mocks.listMetrics }));
vi.mock("./summary", () => ({ getMetricSummary: mocks.getMetricSummary }));

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
): GetMetricSummaryResponse {
  const window = (value: number | null) =>
    value === null ? null : { avg: value, min: value, max: value, count: 3 };
  return {
    metricId: metricId as GetMetricSummaryResponse["metricId"],
    latest: latest === null ? null : { value: latest, occurredAt: new Date() },
    windows: { "7d": window(avg7d), "30d": null, "90d": null },
    trend: null,
  };
}

describe("getMetricMovers", () => {
  it("computes delta/direction against the first non-empty window and ranks by magnitude", async () => {
    const big = newTypeId("metric_definition");
    const small = newTypeId("metric_definition");
    const flat = newTypeId("metric_definition");

    mocks.listMetrics.mockResolvedValue([
      definition(small, "small"),
      definition(big, "big"),
      definition(flat, "flat"),
    ]);
    const summaries: Record<string, GetMetricSummaryResponse> = {
      [small]: summary(small, 105, 100), // +5% → up
      [big]: summary(big, 200, 100), // +100% → up, largest mover
      [flat]: summary(flat, 100, 100), // 0% → flat
    };
    mocks.getMetricSummary.mockImplementation(
      async ({ metricId }: { metricId: string }) => summaries[metricId],
    );

    const movers = await getMetricMovers({ userId: "user_movers" });

    expect(movers.map((m) => m.metricId)).toEqual([big, small, flat]);
    expect(movers[0]).toMatchObject({
      slug: "big",
      latestValue: 200,
      delta: 100,
      direction: "up",
      window: "7d",
    });
    expect(movers[2]).toMatchObject({ direction: "flat", delta: 0 });
    expect(mocks.listMetrics).toHaveBeenCalledWith({
      userId: "user_movers",
      filter: { active: true },
    });
  });

  it("nulls delta/direction/window when a metric has no readings", async () => {
    const id = newTypeId("metric_definition");
    mocks.listMetrics.mockResolvedValue([definition(id, "empty")]);
    mocks.getMetricSummary.mockResolvedValue(summary(id, null, null));

    const [mover] = await getMetricMovers({ userId: "user_movers" });

    expect(mover).toMatchObject({
      latestValue: null,
      delta: null,
      direction: null,
      window: null,
    });
  });

  it("applies the limit after ranking", async () => {
    const a = newTypeId("metric_definition");
    const b = newTypeId("metric_definition");
    mocks.listMetrics.mockResolvedValue([
      definition(a, "a"),
      definition(b, "b"),
    ]);
    const summaries: Record<string, GetMetricSummaryResponse> = {
      [a]: summary(a, 101, 100), // +1%
      [b]: summary(b, 150, 100), // +50%
    };
    mocks.getMetricSummary.mockImplementation(
      async ({ metricId }: { metricId: string }) => summaries[metricId],
    );

    const movers = await getMetricMovers({ userId: "user_movers", limit: 1 });

    expect(movers).toHaveLength(1);
    expect(movers[0]!.slug).toBe("b");
  });
});
