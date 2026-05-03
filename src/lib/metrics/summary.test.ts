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

describe("getMetricSummary", () => {
  it("returns latest reading and aggregate windows", async () => {
    const metricId = newTypeId("metric_definition");
    const latestAt = new Date("2026-05-03T07:30:00.000Z");

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () =>
        fakeDatabase([
          [{ id: metricId, aggregationHint: "avg" }],
          [{ value: "78.4", occurredAt: latestAt }],
          [{ count: 2, avg: "78.2", min: "78.0", max: "78.4", sum: "156.4" }],
          [{ count: 3, avg: "78.1", min: "77.9", max: "78.4", sum: "234.3" }],
          [{ count: 4, avg: "78.0", min: "77.6", max: "78.4", sum: "312.0" }],
        ]),
    }));

    const { getMetricSummary } = await import("./summary");
    await expect(
      getMetricSummary({ userId: "user_metrics", metricId }),
    ).resolves.toEqual({
      metricId,
      latest: { value: 78.4, occurredAt: latestAt },
      windows: {
        "7d": { count: 2, avg: 78.2, min: 78, max: 78.4 },
        "30d": { count: 3, avg: 78.1, min: 77.9, max: 78.4 },
        "90d": { count: 4, avg: 78, min: 77.6, max: 78.4 },
      },
      trend: "flat",
    });
  });
});
