import { describe, expect, it, vi } from "vitest";
import { getMetricSummariesRequestSchema } from "~/lib/schemas/metric-read";
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

// The vectorized reader issues queries in a fixed order regardless of the
// metric count: definitions, latest (DISTINCT ON), then 7d / 30d / 90d windows.
function fakeDatabase(results: QueryResult[]) {
  let index = 0;
  const next = () => {
    const result = results[index] ?? [];
    index += 1;
    return new FakeQuery(result);
  };
  return {
    select: next,
    selectDistinctOn: next,
  };
}

describe("getMetricSummariesRequestSchema", () => {
  it("rejects an empty metricIds array", () => {
    expect(() =>
      getMetricSummariesRequestSchema.parse({
        userId: "user_metrics",
        metricIds: [],
      }),
    ).toThrow();
  });

  it("accepts an omitted metricIds with a filter", () => {
    expect(() =>
      getMetricSummariesRequestSchema.parse({
        userId: "user_metrics",
        filter: { active: true },
      }),
    ).not.toThrow();
  });
});

describe("getMetricSummaries", () => {
  it("vectorizes explicit metricIds, keeps order, and nulls unknown ids", async () => {
    const idA = newTypeId("metric_definition");
    const unknownId = newTypeId("metric_definition");
    const idB = newTypeId("metric_definition");
    const latestA = new Date("2026-05-03T07:30:00.000Z");
    const latestB = new Date("2026-05-02T07:30:00.000Z");

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () =>
        fakeDatabase([
          // definitions (unknownId is absent — not owned by the user)
          [
            { id: idA, aggregationHint: "avg" },
            { id: idB, aggregationHint: "sum" },
          ],
          // latest (DISTINCT ON) — one row per metric with data
          [
            { metricDefinitionId: idA, value: "78.4", occurredAt: latestA },
            { metricDefinitionId: idB, value: "1200", occurredAt: latestB },
          ],
          // 7d windows
          [
            {
              metricDefinitionId: idA,
              count: 2,
              avg: "78.2",
              min: "78.0",
              max: "78.4",
              sum: "156.4",
            },
            {
              metricDefinitionId: idB,
              count: 1,
              avg: "1200",
              min: "1200",
              max: "1200",
              sum: "1200",
            },
          ],
          // 30d windows
          [
            {
              metricDefinitionId: idA,
              count: 3,
              avg: "78.1",
              min: "77.9",
              max: "78.4",
              sum: "234.3",
            },
            {
              metricDefinitionId: idB,
              count: 5,
              avg: "1000",
              min: "800",
              max: "1200",
              sum: "5000",
            },
          ],
          // 90d windows
          [
            {
              metricDefinitionId: idA,
              count: 4,
              avg: "78.0",
              min: "77.6",
              max: "78.4",
              sum: "312.0",
            },
            {
              metricDefinitionId: idB,
              count: 10,
              avg: "900",
              min: "700",
              max: "1200",
              sum: "9000",
            },
          ],
        ]),
    }));

    const { getMetricSummaries } = await import("./summary");
    const result = await getMetricSummaries({
      userId: "user_metrics",
      // Deliberately out of label order, with an unknown id in the middle.
      metricIds: [idB, unknownId, idA],
    });

    expect(result.summaries).toEqual([
      {
        metricId: idB,
        latest: { value: 1200, occurredAt: latestB },
        windows: {
          "7d": { count: 1, avg: 1200, min: 1200, max: 1200 },
          "30d": { count: 5, avg: 1000, min: 800, max: 1200 },
          "90d": { count: 10, avg: 900, min: 700, max: 1200 },
        },
        // sum-hinted: 30d sum 5000 vs 90d sum 9000 → down
        trend: "down",
      },
      {
        metricId: unknownId,
        latest: null,
        windows: { "7d": null, "30d": null, "90d": null },
        trend: null,
      },
      {
        metricId: idA,
        latest: { value: 78.4, occurredAt: latestA },
        windows: {
          "7d": { count: 2, avg: 78.2, min: 78, max: 78.4 },
          "30d": { count: 3, avg: 78.1, min: 77.9, max: 78.4 },
          "90d": { count: 4, avg: 78, min: 77.6, max: 78.4 },
        },
        // avg-hinted: 30d avg 78.1 vs 90d avg 78.0 → within 1% → flat
        trend: "flat",
      },
    ]);
  });

  it("drops dataless metrics when filtering to active and no ids are given", async () => {
    const activeId = newTypeId("metric_definition");
    const dormantId = newTypeId("metric_definition");
    const latestAt = new Date("2026-05-03T07:30:00.000Z");

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () =>
        fakeDatabase([
          // definitions, already ordered by (label, slug)
          [
            { id: activeId, aggregationHint: "avg" },
            { id: dormantId, aggregationHint: "avg" },
          ],
          // latest — only the active metric has an observation
          [
            {
              metricDefinitionId: activeId,
              value: "78.4",
              occurredAt: latestAt,
            },
          ],
          // 7d / 30d / 90d windows — only the active metric appears
          [
            {
              metricDefinitionId: activeId,
              count: 1,
              avg: "78.4",
              min: "78.4",
              max: "78.4",
              sum: "78.4",
            },
          ],
          [
            {
              metricDefinitionId: activeId,
              count: 1,
              avg: "78.4",
              min: "78.4",
              max: "78.4",
              sum: "78.4",
            },
          ],
          [
            {
              metricDefinitionId: activeId,
              count: 1,
              avg: "78.4",
              min: "78.4",
              max: "78.4",
              sum: "78.4",
            },
          ],
        ]),
    }));

    const { getMetricSummaries } = await import("./summary");
    const result = await getMetricSummaries({
      userId: "user_metrics",
      filter: { active: true },
    });

    expect(result.summaries.map((summary) => summary.metricId)).toEqual([
      activeId,
    ]);
  });

  it("returns null-filled summaries when none of the requested ids exist", async () => {
    const missingId = newTypeId("metric_definition");

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => fakeDatabase([[]]),
    }));

    const { getMetricSummaries } = await import("./summary");
    await expect(
      getMetricSummaries({
        userId: "user_metrics",
        metricIds: [missingId],
      }),
    ).resolves.toEqual({
      summaries: [
        {
          metricId: missingId,
          latest: null,
          windows: { "7d": null, "30d": null, "90d": null },
          trend: null,
        },
      ],
    });
  });
});
