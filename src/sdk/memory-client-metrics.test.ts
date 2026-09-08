import { contextPartitionKeySchema } from "../lib/schemas/partition";
import { MemoryClient } from "./memory-client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MemoryClient metric writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the caller-owned partition on manual and bulk writes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          inserted: 1,
          errors: [],
          definitionCreated: false,
          needsReview: false,
          reviewTaskNodeId: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ inserted: 1, errors: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ metrics: [] }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    const partitionKey = contextPartitionKeySchema.parse("room:client-a");

    await client.recordMetric({
      userId: "user_metrics",
      partitionKey,
      metric: {
        slug: "focus_minutes",
        label: "Focus minutes",
        description: "Minutes of focused work",
        unit: "minutes",
        aggregationHint: "sum",
      },
      value: 45,
      occurredAt: new Date("2026-07-13T10:00:00.000Z"),
    });
    await client.recordMetricsBulk({
      userId: "user_metrics",
      partitionKey,
      sourceExternalId: "calendar:focus-session-1",
      observations: [
        {
          metricSlug: "focus_minutes",
          value: 45,
          occurredAt: new Date("2026-07-13T10:00:00.000Z"),
        },
      ],
    });
    await client.listMetrics({ userId: "user_metrics", partitionKey });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://memory.test/metrics/observations",
      expect.objectContaining({
        body: JSON.stringify({
          userId: "user_metrics",
          partitionKey: "room:client-a",
          metric: {
            slug: "focus_minutes",
            label: "Focus minutes",
            description: "Minutes of focused work",
            unit: "minutes",
            aggregationHint: "sum",
          },
          value: 45,
          occurredAt: "2026-07-13T10:00:00.000Z",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://memory.test/metrics/observations/bulk",
      expect.objectContaining({
        body: JSON.stringify({
          userId: "user_metrics",
          partitionKey: "room:client-a",
          sourceExternalId: "calendar:focus-session-1",
          observations: [
            {
              metricSlug: "focus_minutes",
              value: 45,
              occurredAt: "2026-07-13T10:00:00.000Z",
            },
          ],
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "http://memory.test/metrics/list",
      expect.objectContaining({
        body: JSON.stringify({
          userId: "user_metrics",
          partitionKey: "room:client-a",
        }),
      }),
    );
  });
});
