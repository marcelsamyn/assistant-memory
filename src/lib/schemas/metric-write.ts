import { typeIdSchema } from "../../types/typeid.js";
import {
  metricAggregationHintSchema,
  proposedMetricDefinitionSchema,
} from "./metric-definition.js";
import { metricObservationErrorCodeSchema } from "./metric-observation.js";
import { z } from "zod";

export { metricAggregationHintSchema } from "./metric-definition.js";

export const metricSeriesAggregationSchema = z.enum([
  "avg",
  "sum",
  "min",
  "max",
  "p50",
  "p90",
]);

export const metricDefinitionInputSchema = proposedMetricDefinitionSchema;

export const recordMetricRequestSchema = z.object({
  userId: z.string().min(1),
  metric: metricDefinitionInputSchema,
  value: z.number(),
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  note: z.string().max(2000).nullable().optional(),
});

export const bulkRecordMetricObservationSchema = z.object({
  metricSlug: z.string().regex(/^[a-z0-9_]{1,80}$/),
  value: z.number(),
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  note: z.string().max(2000).nullable().optional(),
});

export const bulkRecordMetricsRequestSchema = z.object({
  userId: z.string().min(1),
  sourceExternalId: z.string().min(1).max(200),
  observations: z.array(bulkRecordMetricObservationSchema).min(1).max(5000),
});

export const metricWriteErrorSchema = z.object({
  index: z.number().int().nonnegative(),
  code: metricObservationErrorCodeSchema,
  message: z.string(),
});

export const metricWriteResponseSchema = z.object({
  inserted: z.number().int().min(0),
  errors: z.array(metricWriteErrorSchema),
  definitionCreated: z.boolean().optional(),
  needsReview: z.boolean().optional(),
  reviewTaskNodeId: typeIdSchema("node").nullable().optional(),
});

export const recordMetricResponseSchema = metricWriteResponseSchema.extend({
  definitionCreated: z.boolean(),
  needsReview: z.boolean(),
  reviewTaskNodeId: typeIdSchema("node").nullable(),
});

export const bulkRecordMetricsResponseSchema = metricWriteResponseSchema;

export type MetricAggregationHint = z.infer<typeof metricAggregationHintSchema>;
export type MetricDefinitionInput = z.infer<typeof metricDefinitionInputSchema>;
export type RecordMetricRequest = z.infer<typeof recordMetricRequestSchema>;
export type RecordMetricResponse = z.infer<typeof recordMetricResponseSchema>;
export type MetricWriteResponse = z.infer<typeof metricWriteResponseSchema>;
export type BulkRecordMetricsRequest = z.infer<
  typeof bulkRecordMetricsRequestSchema
>;
export type BulkRecordMetricsResponse = z.infer<
  typeof bulkRecordMetricsResponseSchema
>;
