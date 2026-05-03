import { typeIdSchema } from "../../types/typeid.js";
import { proposedMetricDefinitionSchema } from "./metric-definition.js";
import { z } from "zod";

export const metricObservationSchema = z.object({
  id: typeIdSchema("metric_observation"),
  userId: z.string(),
  metricDefinitionId: typeIdSchema("metric_definition"),
  value: z.coerce.number(),
  occurredAt: z.coerce.date(),
  note: z.string().nullable(),
  eventNodeId: typeIdSchema("node").nullable(),
  sourceId: typeIdSchema("source"),
  createdAt: z.coerce.date(),
});

export const metricObservationWriteSchema = z.object({
  metric: proposedMetricDefinitionSchema.optional(),
  metricSlug: z.string().min(1).optional(),
  value: z.number(),
  occurredAt: z.coerce.date(),
  note: z.string().optional(),
  eventNodeId: typeIdSchema("node").optional(),
});

export const metricObservationErrorCodeSchema = z.enum([
  "DEFINITION_NOT_FOUND",
  "RANGE_VIOLATION",
  "RESOLVE_FAILED",
  "INVALID_INPUT",
]);

export type MetricObservation = z.infer<typeof metricObservationSchema>;
export type MetricObservationWrite = z.infer<
  typeof metricObservationWriteSchema
>;
export type MetricObservationErrorCode = z.infer<
  typeof metricObservationErrorCodeSchema
>;
