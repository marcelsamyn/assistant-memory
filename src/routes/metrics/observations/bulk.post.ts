import {
  recordMetricObservations,
  resolveMetricObservationPartition,
} from "~/lib/metrics/observations";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  bulkRecordMetricsRequestSchema,
  bulkRecordMetricsResponseSchema,
} from "~/lib/schemas/metric-write";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, sourceExternalId, observations } =
    parseRequestBody(bulkRecordMetricsRequestSchema, await readBody(event));
  const accessScope = getRequestAccessScope(event);
  const resolvedPartitionKey = await resolveMetricObservationPartition(
    await useDatabase(),
    userId,
    partitionKey,
    { type: "metric_push", externalId: sourceExternalId },
    accessScope,
  );
  const result = await recordMetricObservations({
    userId,
    partitionKey: resolvedPartitionKey,
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
