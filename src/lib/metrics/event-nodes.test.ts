import { describe, expect, it, vi } from "vitest";
import { metricEventAdditionalData } from "~/lib/metrics/event-nodes";

vi.mock("~/lib/embeddings-util", () => ({
  generateAndInsertNodeEmbeddings: async () => undefined,
}));

describe("metric event nodes", () => {
  it("stores the deterministic event key in additional data", () => {
    expect(
      metricEventAdditionalData(
        "run:2026-05-03T06:30:00.000Z",
        new Date("2026-05-03T06:30:00.000Z"),
      ),
    ).toEqual({
      metricEventKey: "run:2026-05-03T06:30:00.000Z",
      occurredAt: "2026-05-03T06:30:00.000Z",
    });
  });
});
