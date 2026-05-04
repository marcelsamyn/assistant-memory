import { typeIdSchema } from "../../types/typeid.js";
import {
  metricAggregationHintSchema,
  metricSeriesAggregationSchema,
} from "./metric-write.js";
import { z } from "zod";

export const metricDefinitionSchema = z.object({
  id: typeIdSchema("metric_definition"),
  slug: z.string(),
  label: z.string(),
  description: z.string(),
  unit: z.string(),
  aggregationHint: metricAggregationHintSchema,
  validRange: z.object({
    min: z.number().nullable(),
    max: z.number().nullable(),
  }),
  needsReview: z.boolean(),
  reviewTaskNodeId: typeIdSchema("node").nullable(),
});

export const metricDefinitionWithStatsSchema = metricDefinitionSchema.extend({
  stats: z.object({
    observationCount: z.number().int().min(0),
    firstAt: z.coerce.date().nullable(),
    latestAt: z.coerce.date().nullable(),
    latestValue: z.number().nullable(),
  }),
});

export const listMetricsRequestSchema = z.object({
  userId: z.string().min(1),
  filter: z
    .object({
      active: z.boolean().optional(),
      needsReview: z.boolean().optional(),
      search: z.string().max(200).optional(),
    })
    .optional(),
});

export const listMetricsResponseSchema = z.object({
  metrics: z.array(metricDefinitionWithStatsSchema),
});

export const metricSeriesBucketSchema = z.enum([
  "none",
  "hour",
  "day",
  "week",
  "month",
]);

export const getMetricSeriesRequestSchema = z.object({
  userId: z.string().min(1),
  metricIds: z.array(typeIdSchema("metric_definition")).min(1).max(20),
  from: z.string().datetime().pipe(z.coerce.date()),
  to: z.string().datetime().pipe(z.coerce.date()),
  bucket: metricSeriesBucketSchema,
  agg: metricSeriesAggregationSchema.optional(),
});

export const metricSeriesPointSchema = z.object({
  t: z.coerce.date(),
  value: z.number(),
});

export const getMetricSeriesResponseSchema = z.object({
  series: z.array(
    z.object({
      metricId: typeIdSchema("metric_definition"),
      points: z.array(metricSeriesPointSchema),
      truncated: z.boolean().optional(),
    }),
  ),
});

export const getMetricSummaryRequestSchema = z.object({
  userId: z.string().min(1),
  metricId: typeIdSchema("metric_definition"),
});

export const metricSummaryWindowSchema = z.object({
  avg: z.number(),
  min: z.number(),
  max: z.number(),
  count: z.number().int(),
});

export const getMetricSummaryResponseSchema = z.object({
  metricId: typeIdSchema("metric_definition"),
  latest: z
    .object({
      value: z.number(),
      occurredAt: z.coerce.date(),
    })
    .nullable(),
  windows: z.object({
    "7d": metricSummaryWindowSchema.nullable(),
    "30d": metricSummaryWindowSchema.nullable(),
    "90d": metricSummaryWindowSchema.nullable(),
  }),
  trend: z.enum(["up", "down", "flat"]).nullable(),
});

export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
export type MetricDefinitionWithStats = z.infer<
  typeof metricDefinitionWithStatsSchema
>;
export type ListMetricsRequest = z.infer<typeof listMetricsRequestSchema>;
export type ListMetricsResponse = z.infer<typeof listMetricsResponseSchema>;
export type MetricSeriesBucket = z.infer<typeof metricSeriesBucketSchema>;
export type MetricSeriesAggregation = z.infer<
  typeof metricSeriesAggregationSchema
>;
export type GetMetricSeriesRequest = z.infer<
  typeof getMetricSeriesRequestSchema
>;
export type GetMetricSeriesResponse = z.infer<
  typeof getMetricSeriesResponseSchema
>;
export type GetMetricSummaryRequest = z.infer<
  typeof getMetricSummaryRequestSchema
>;
export type GetMetricSummaryResponse = z.infer<
  typeof getMetricSummaryResponseSchema
>;
