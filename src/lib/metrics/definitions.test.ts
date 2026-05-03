import { describe, expect, it, vi } from "vitest";
import { HIGH_SIMILARITY, MID_SIMILARITY } from "~/lib/metrics/constants";
import { metricDefinitionEmbeddingText } from "~/lib/metrics/definitions";
import { proposedMetricDefinitionSchema } from "~/lib/schemas/metric-definition";

vi.mock("~/lib/embeddings", () => ({
  generateEmbeddings: async () => ({
    data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
    usage: { total_tokens: 0 },
  }),
}));

vi.mock("~/lib/node", () => ({
  createNode: async () => ({
    id: "node_00000000000000000000000000",
    nodeType: "Task",
    label: "Review proposed metric",
    description: null,
    initialClaimIds: [],
  }),
}));

describe("metric definitions", () => {
  it("exposes review threshold constants", () => {
    expect(HIGH_SIMILARITY).toBe(0.85);
    expect(MID_SIMILARITY).toBe(0.7);
  });

  it("validates proposed definitions with aggregation hints", () => {
    const parsed = proposedMetricDefinitionSchema.parse({
      slug: "running_pace_min_per_km",
      label: "Running pace",
      description: "Average running pace in minutes per kilometer",
      unit: "min/km",
      aggregationHint: "avg",
      validRangeMin: 2,
      validRangeMax: 12,
    });

    expect(parsed.aggregationHint).toBe("avg");
  });

  it("rejects invalid range ordering", () => {
    expect(() =>
      proposedMetricDefinitionSchema.parse({
        slug: "readiness",
        label: "Readiness",
        description: "Readiness score",
        unit: "score",
        aggregationHint: "avg",
        validRangeMin: 100,
        validRangeMax: 0,
      }),
    ).toThrow();
  });

  it("uses label and description as embedding text", () => {
    expect(
      metricDefinitionEmbeddingText({
        label: "Body weight",
        description: "Morning bathroom scale weight",
      }),
    ).toBe("Body weight\nMorning bathroom scale weight");
  });
});
