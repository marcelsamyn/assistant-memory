import { describe, expect, it, vi } from "vitest";
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

  limit(): FakeQuery {
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

describe("getMetricSeries", () => {
  it("returns raw points in request order", async () => {
    const metricId = newTypeId("metric_definition");
    const missingMetricId = newTypeId("metric_definition");
    const firstAt = new Date("2026-05-01T00:00:00.000Z");
    const secondAt = new Date("2026-05-02T00:00:00.000Z");
    const database = fakeDatabase([
      [{ id: metricId, aggregationHint: "avg" }],
      [
        { t: firstAt, value: "1.5" },
        { t: secondAt, value: "2.5" },
      ],
    ]);

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    const { getMetricSeries } = await import("./series");
    await expect(
      getMetricSeries({
        userId: "user_metrics",
        metricIds: [missingMetricId, metricId],
        from: firstAt,
        to: secondAt,
        bucket: "none",
      }),
    ).resolves.toEqual({
      series: [
        { metricId: missingMetricId, points: [] },
        {
          metricId,
          points: [
            { t: firstAt, value: 1.5 },
            { t: secondAt, value: 2.5 },
          ],
        },
      ],
    });
  });
});
