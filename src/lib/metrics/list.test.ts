import { describe, expect, it, vi } from "vitest";
import { listMetricsRequestSchema } from "~/lib/schemas/metric-read";
import { newTypeId } from "~/types/typeid";

type QueryResult = ReadonlyArray<unknown>;

class FakeQuery {
  constructor(private readonly result: QueryResult) {}

  from(): FakeQuery {
    return this;
  }

  where(): FakeQuery {
    return this;
  }

  orderBy(): FakeQuery {
    return this;
  }

  groupBy(): FakeQuery {
    return this;
  }

  then<TResult1 = QueryResult, TResult2 = never>(
    onfulfilled?:
      | ((value: QueryResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.result).then(onfulfilled, onrejected);
  }
}

function fakeDatabase(results: QueryResult[]) {
  let index = 0;
  return {
    select() {
      const result = results[index] ?? [];
      index += 1;
      return new FakeQuery(result);
    },
  };
}

describe("listMetrics", () => {
  it("accepts an empty search filter from UI forms", () => {
    expect(() =>
      listMetricsRequestSchema.parse({
        userId: "user_metrics",
        filter: { search: "" },
      }),
    ).not.toThrow();
  });

  it("returns definitions with stats and active filtering", async () => {
    const metricId = newTypeId("metric_definition");
    const inactiveMetricId = newTypeId("metric_definition");
    const reviewTaskNodeId = newTypeId("node");
    const firstAt = new Date("2026-05-01T00:00:00.000Z");
    const latestAt = new Date("2026-05-03T00:00:00.000Z");

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () =>
        fakeDatabase([
          [
            {
              id: metricId,
              slug: "body_weight",
              label: "Body weight",
              description: "Morning body weight",
              unit: "kg",
              aggregationHint: "avg",
              validRangeMin: "40",
              validRangeMax: "140",
              needsReview: true,
              reviewTaskNodeId,
            },
            {
              id: inactiveMetricId,
              slug: "steps",
              label: "Steps",
              description: "Daily steps",
              unit: "steps",
              aggregationHint: "sum",
              validRangeMin: null,
              validRangeMax: null,
              needsReview: false,
              reviewTaskNodeId: null,
            },
          ],
          [
            {
              metricDefinitionId: metricId,
              observationCount: 2,
              firstAt,
              latestAt,
            },
          ],
          [
            {
              metricDefinitionId: metricId,
              value: "78.4",
              occurredAt: latestAt,
            },
          ],
        ]),
    }));

    const { listMetrics } = await import("./list");
    await expect(
      listMetrics({ userId: "user_metrics", filter: { active: true } }),
    ).resolves.toEqual([
      {
        id: metricId,
        slug: "body_weight",
        label: "Body weight",
        description: "Morning body weight",
        unit: "kg",
        aggregationHint: "avg",
        validRange: { min: 40, max: 140 },
        needsReview: true,
        reviewTaskNodeId,
        stats: {
          observationCount: 2,
          firstAt,
          latestAt,
          latestValue: 78.4,
        },
      },
    ]);
  });
});
