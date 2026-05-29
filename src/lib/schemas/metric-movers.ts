/**
 * Schemas for metric "movers" — per-metric latest value plus the recent
 * delta/direction needed to render a digest or dashboard "what moved"
 * panel in one call, instead of an N+1 `getMetricSummary` fan-out.
 */
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid.js";

export const metricMoverWindowSchema = z.enum(["7d", "30d", "90d"]);
export type MetricMoverWindow = z.infer<typeof metricMoverWindowSchema>;

export const metricMoverDirectionSchema = z.enum(["up", "down", "flat"]);
export type MetricMoverDirection = z.infer<typeof metricMoverDirectionSchema>;

export const metricMoverSchema = z.object({
  metricId: typeIdSchema("metric_definition"),
  slug: z.string(),
  label: z.string(),
  unit: z.string(),
  latestValue: z.number().nullable(),
  /** Latest reading minus the baseline window average; null without data. */
  delta: z.number().nullable(),
  direction: metricMoverDirectionSchema.nullable(),
  /** Window the delta was measured against (first non-empty of 7d/30d/90d). */
  window: metricMoverWindowSchema.nullable(),
});
export type MetricMover = z.infer<typeof metricMoverSchema>;

export const getMetricMoversRequestSchema = z.object({
  userId: z.string().min(1),
  /** Restrict to these metrics; omitted = all metrics with observations. */
  metricIds: z.array(typeIdSchema("metric_definition")).optional(),
  /** Keep only the top-N movers by normalized magnitude. */
  limit: z.number().int().positive().max(100).optional(),
});
export type GetMetricMoversRequest = z.infer<
  typeof getMetricMoversRequestSchema
>;

export const getMetricMoversResponseSchema = z.object({
  movers: z.array(metricMoverSchema),
});
export type GetMetricMoversResponse = z.infer<
  typeof getMetricMoversResponseSchema
>;
