import { describe, expect, it, vi } from "vitest";
import {
  MetricObservationOutOfRangeError,
  assertMetricObservationInRange,
} from "~/lib/metrics/observations";
import type { MetricDefinition } from "~/lib/schemas/metric-definition";
import { newTypeId } from "~/types/typeid";

vi.mock("~/lib/metrics/definitions", () => ({
  getMetricDefinitionBySlug: async () => null,
  resolveMetricDefinition: async () => {
    throw new Error("not used");
  },
}));

vi.mock("~/utils/db", () => ({
  useDatabase: async () => {
    throw new Error("not used");
  },
}));

function definition(
  range: Pick<MetricDefinition, "validRangeMin" | "validRangeMax">,
): MetricDefinition {
  return {
    id: newTypeId("metric_definition"),
    userId: "user_A",
    slug: "resting_hr",
    label: "Resting heart rate",
    description: "Morning resting heart rate",
    unit: "bpm",
    aggregationHint: "avg",
    validRangeMin: range.validRangeMin,
    validRangeMax: range.validRangeMax,
    needsReview: false,
    reviewTaskNodeId: null,
    createdAt: new Date("2026-05-03T00:00:00.000Z"),
    updatedAt: new Date("2026-05-03T00:00:00.000Z"),
  };
}

describe("metric observation range guard", () => {
  it("accepts values inside inclusive bounds", () => {
    expect(() =>
      assertMetricObservationInRange(
        definition({ validRangeMin: 30, validRangeMax: 220 }),
        30,
      ),
    ).not.toThrow();
    expect(() =>
      assertMetricObservationInRange(
        definition({ validRangeMin: 30, validRangeMax: 220 }),
        220,
      ),
    ).not.toThrow();
  });

  it("rejects values outside configured bounds", () => {
    expect(() =>
      assertMetricObservationInRange(
        definition({ validRangeMin: 30, validRangeMax: 220 }),
        229,
      ),
    ).toThrow(MetricObservationOutOfRangeError);
  });

  it("allows open-ended ranges", () => {
    expect(() =>
      assertMetricObservationInRange(
        definition({ validRangeMin: null, validRangeMax: 100 }),
        0,
      ),
    ).not.toThrow();
  });
});
