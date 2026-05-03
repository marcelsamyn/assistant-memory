import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const metricAggregationHintSchema = z.enum(["avg", "sum", "min", "max"]);
export type MetricAggregationHint = z.infer<typeof metricAggregationHintSchema>;

export const proposedMetricDefinitionSchema = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9_]{1,80}$/, "lowercase snake_case slug, max 80 chars"),
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(2000),
    unit: z.string().min(1).max(40),
    aggregationHint: metricAggregationHintSchema,
    validRangeMin: z.number().optional(),
    validRangeMax: z.number().optional(),
  })
  .refine(
    (value) =>
      value.validRangeMin === undefined ||
      value.validRangeMax === undefined ||
      value.validRangeMin <= value.validRangeMax,
    {
      message: "validRangeMin must be less than or equal to validRangeMax",
      path: ["validRangeMin"],
    },
  );

export const metricDefinitionSchema = z.object({
  id: typeIdSchema("metric_definition"),
  userId: z.string(),
  slug: z.string(),
  label: z.string(),
  description: z.string(),
  unit: z.string(),
  aggregationHint: metricAggregationHintSchema,
  validRangeMin: z.coerce.number().nullable(),
  validRangeMax: z.coerce.number().nullable(),
  needsReview: z.boolean(),
  reviewTaskNodeId: typeIdSchema("node").nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export type ProposedMetricDefinition = z.infer<
  typeof proposedMetricDefinitionSchema
>;
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;
