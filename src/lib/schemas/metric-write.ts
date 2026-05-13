import { typeIdSchema } from "../../types/typeid.js";
import {
  metricAggregationHintSchema,
  metricDefinitionSchema,
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

export const updateMetricDefinitionRequestSchema = z
  .object({
    userId: z.string().min(1),
    metricDefinitionId: typeIdSchema("metric_definition"),
    slug: z
      .string()
      .regex(/^[a-z0-9_]{1,80}$/, "lowercase snake_case slug, max 80 chars")
      .optional(),
    label: z.string().min(1).max(200).optional(),
    description: z.string().min(1).max(2000).optional(),
    unit: z.string().min(1).max(40).optional(),
    aggregationHint: metricAggregationHintSchema.optional(),
    validRangeMin: z.number().nullable().optional(),
    validRangeMax: z.number().nullable().optional(),
    needsReview: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.slug !== undefined ||
      value.label !== undefined ||
      value.description !== undefined ||
      value.unit !== undefined ||
      value.aggregationHint !== undefined ||
      value.validRangeMin !== undefined ||
      value.validRangeMax !== undefined ||
      value.needsReview !== undefined,
    { message: "At least one field must be provided" },
  );

export const updateMetricDefinitionResponseSchema = z.object({
  definition: metricDefinitionSchema,
});

export const deleteMetricDefinitionRequestSchema = z.object({
  userId: z.string().min(1),
  metricDefinitionId: typeIdSchema("metric_definition"),
});

export const deleteMetricDefinitionResponseSchema = z.object({
  deleted: z.literal(true),
  deletedObservationCount: z.number().int().min(0),
});

export type UpdateMetricDefinitionRequest = z.infer<
  typeof updateMetricDefinitionRequestSchema
>;
export type UpdateMetricDefinitionResponse = z.infer<
  typeof updateMetricDefinitionResponseSchema
>;
export type DeleteMetricDefinitionRequest = z.infer<
  typeof deleteMetricDefinitionRequestSchema
>;
export type DeleteMetricDefinitionResponse = z.infer<
  typeof deleteMetricDefinitionResponseSchema
>;
