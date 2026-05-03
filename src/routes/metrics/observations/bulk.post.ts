import { recordMetricObservations } from "~/lib/metrics/observations";
import {
  bulkRecordMetricsRequestSchema,
  bulkRecordMetricsResponseSchema,
} from "~/lib/schemas/metric-write";

export default defineEventHandler(async (event) => {
  const { userId, sourceExternalId, observations } =
    bulkRecordMetricsRequestSchema.parse(await readBody(event));
  const result = await recordMetricObservations({
    userId,
    source: { type: "metric_push", externalId: sourceExternalId },
    createDefinitions: false,
    events: [],
    observations: observations.map((observation) => ({
      metricSlug: observation.metricSlug,
      value: observation.value,
      occurredAt: observation.occurredAt,
      note: observation.note ?? null,
    })),
  });
  return bulkRecordMetricsResponseSchema.parse({
    inserted: result.inserted,
    errors: result.errors,
  });
});
