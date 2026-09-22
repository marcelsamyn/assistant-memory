import {
  recordMetricObservations,
  resolveMetricObservationPartition,
} from "~/lib/metrics/observations";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  recordMetricRequestSchema,
  recordMetricResponseSchema,
} from "~/lib/schemas/metric-write";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const {
    userId,
    partitionKey: requestedPartitionKey,
    metric,
    value,
    occurredAt,
    note,
  } = parseRequestBody(recordMetricRequestSchema, await readBody(event));
  const accessScope = getRequestAccessScope(event);
  const partitionKey = await resolveMetricObservationPartition(
    await useDatabase(),
    userId,
    requestedPartitionKey,
    { type: "metric_manual", externalId: `metric_manual:${userId}` },
    accessScope,
  );
  const result = await recordMetricObservations({
    userId,
    partitionKey,
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
