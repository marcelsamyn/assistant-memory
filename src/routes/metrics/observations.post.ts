import { recordMetricObservations } from "~/lib/metrics/observations";
import {
  recordMetricRequestSchema,
  recordMetricResponseSchema,
} from "~/lib/schemas/metric-write";

export default defineEventHandler(async (event) => {
  const { userId, metric, value, occurredAt, note } =
    recordMetricRequestSchema.parse(await readBody(event));
  const result = await recordMetricObservations({
    userId,
    source: { type: "metric_manual" },
    createDefinitions: true,
    events: [],
    observations: [{ metric, value, occurredAt, note: note ?? null }],
  });
  const [observation] = result.observations;
  const response = {
    inserted: result.inserted,
    errors: result.errors,
    definitionCreated: observation?.definitionCreated ?? false,
    needsReview: observation?.needsReview ?? false,
    reviewTaskNodeId: observation?.reviewTaskNodeId ?? null,
  };
  if (result.errors.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: result.errors[0]?.message ?? "Metric observation failed",
      data: response,
    });
  }
  if (observation === undefined) {
    throw createError({
      statusCode: 500,
      statusMessage: "Metric observation was not recorded",
    });
  }
  return recordMetricResponseSchema.parse(response);
});
