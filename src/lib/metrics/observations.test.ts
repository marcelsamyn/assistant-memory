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

describe("recordMetricObservations with createDefinitions: false", () => {
  it("attaches LLM-proposed observations to existing metrics via slug lookup", async () => {
    const existing = definition({ validRangeMin: null, validRangeMax: null });
    const inserted: unknown[] = [];
    const fakeDb = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: (value: unknown) => ({
          returning: async () => {
            inserted.push(value);
            return [
              {
                id: newTypeId("metric_observation"),
                metricDefinitionId: existing.id,
              },
            ];
          },
        }),
      }),
    };

    vi.resetModules();
    vi.doMock("~/lib/metrics/definitions", () => ({
      getMetricDefinitionBySlug: async () => existing,
      resolveMetricDefinition: async () => {
        throw new Error("must not be called when createDefinitions is false");
      },
    }));
    vi.doMock("~/lib/metrics/sources", () => ({
      upsertMetricManualSource: async () => newTypeId("source"),
      upsertMetricPushSource: async () => newTypeId("source"),
    }));
    vi.doMock("~/lib/metrics/event-nodes", () => ({
      ensureMetricEventNode: async () => newTypeId("node"),
    }));
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => fakeDb }));

    const { recordMetricObservations } = await import(
      "~/lib/metrics/observations"
    );
    const result = await recordMetricObservations({
      userId: "user_A",
      source: { type: "metric_manual" },
      createDefinitions: false,
      observations: [
        {
          metric: {
            slug: "resting_hr",
            label: "Resting HR",
            description: "Morning resting heart rate",
            unit: "bpm",
            aggregationHint: "avg",
          },
          value: 58,
          occurredAt: new Date("2026-05-12T07:00:00.000Z"),
        },
      ],
    });

    expect(result.inserted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(inserted).toHaveLength(1);
  });

  it("skips observations whose slug doesn't match any existing metric", async () => {
    const fakeDb = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new Error("insert must not be called when slug is unknown");
          },
        }),
      }),
    };

    vi.resetModules();
    vi.doMock("~/lib/metrics/definitions", () => ({
      getMetricDefinitionBySlug: async () => null,
      resolveMetricDefinition: async () => {
        throw new Error("must not be called when createDefinitions is false");
      },
    }));
    vi.doMock("~/lib/metrics/sources", () => ({
      upsertMetricManualSource: async () => newTypeId("source"),
      upsertMetricPushSource: async () => newTypeId("source"),
    }));
    vi.doMock("~/lib/metrics/event-nodes", () => ({
      ensureMetricEventNode: async () => newTypeId("node"),
    }));
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => fakeDb }));

    const { recordMetricObservations } = await import(
      "~/lib/metrics/observations"
    );
    const result = await recordMetricObservations({
      userId: "user_A",
      source: { type: "metric_manual" },
      createDefinitions: false,
      observations: [
        {
          metric: {
            slug: "height_of_sam",
            label: "Height of Sam",
            description: "Sam's height mentioned in chat",
            unit: "cm",
            aggregationHint: "avg",
          },
          value: 182,
          occurredAt: new Date("2026-05-12T07:00:00.000Z"),
        },
      ],
    });

    expect(result.inserted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("DEFINITION_NOT_FOUND");
  });
});
