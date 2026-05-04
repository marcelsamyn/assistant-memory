/**
 * Side-effect-free schemas for graph-extraction structured LLM output.
 * Common aliases: subgraph response_format schema, extraction JSON schema.
 */
import { z } from "zod";
import {
  AssertedByKindEnum,
  AttributePredicateEnum,
  NodeTypeEnum,
  RelationshipPredicateEnum,
} from "~/types/graph";

const llmNodeSchema = z.object({
  id: z.string().describe("id to reference in claims"),
  type: NodeTypeEnum.describe("one of the allowed node types"),
  label: z.string().describe("human-readable name/title"),
  description: z.string().describe("longer text description").optional(),
});

const llmRelationshipClaimSchema = z.object({
  subjectId: z.string().describe("id of the subject node"),
  objectId: z.string().describe("id of the object node"),
  predicate: RelationshipPredicateEnum.describe(
    "one of the allowed predicates",
  ),
  statement: z.string().describe("short sentence stating the sourced claim"),
  sourceRef: z
    .string()
    .min(1)
    .describe("source reference that supports the claim"),
  assertionKind: AssertedByKindEnum.describe(
    "who asserted this claim (see CRITICAL EXTRACTION RULES)",
  ),
  assertedBySpeakerLabel: z.string().optional(),
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const llmAttributeClaimSchema = z.object({
  subjectId: z.string().describe("id of the subject node"),
  predicate: AttributePredicateEnum.describe("one of the allowed predicates"),
  objectValue: z.string().describe("scalar value for the attribute claim"),
  statement: z.string().describe("short sentence stating the sourced claim"),
  sourceRef: z
    .string()
    .min(1)
    .describe("source reference that supports the claim"),
  assertionKind: AssertedByKindEnum.describe(
    "who asserted this claim (see CRITICAL EXTRACTION RULES)",
  ),
  assertedBySpeakerLabel: z.string().optional(),
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

const llmAliasSchema = z.object({
  subjectId: z.string().describe("id of the node being aliased"),
  aliasText: z
    .string()
    .min(1)
    .describe("alternate name or spelling for the node"),
});

function createLlmMetricDefinitionSchema(): z.ZodObject<{
  slug: z.ZodString;
  label: z.ZodString;
  description: z.ZodString;
  unit: z.ZodString;
  aggregationHint: z.ZodEnum<["avg", "sum", "min", "max"]>;
  validRangeMin: z.ZodOptional<z.ZodNumber>;
  validRangeMax: z.ZodOptional<z.ZodNumber>;
}> {
  return z.object({
    slug: z.string().describe("lowercase snake_case stable identifier"),
    label: z.string().describe("human display name"),
    description: z.string().describe("one-line meaning used for deduplication"),
    unit: z.string().describe("canonical unit"),
    aggregationHint: z.enum(["avg", "sum", "min", "max"]),
    validRangeMin: z.number().optional(),
    validRangeMax: z.number().optional(),
  });
}

const llmMetricEventObservationSchema = z.object({
  metric: createLlmMetricDefinitionSchema(),
  value: z.number(),
  note: z.string().optional(),
});

const llmMetricStandaloneObservationSchema = z.object({
  metric: createLlmMetricDefinitionSchema(),
  value: z.number(),
  note: z.string().optional(),
  occurredAt: z.string().datetime(),
});

const llmMetricEventSchema = z.object({
  eventKey: z
    .string()
    .describe("stable event key unique within this extraction"),
  label: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  eventNodeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "optional temporary or existing Event node id when claims also reference it",
    ),
  observations: z.array(llmMetricEventObservationSchema),
});

export const llmMetricsSchema = z.object({
  events: z.array(llmMetricEventSchema).optional(),
  standalone: z.array(llmMetricStandaloneObservationSchema).optional(),
});

export const llmExtractionSchema = z.object({
  nodes: z.array(llmNodeSchema),
  relationshipClaims: z.array(llmRelationshipClaimSchema),
  attributeClaims: z.array(llmAttributeClaimSchema),
  aliases: z.array(llmAliasSchema),
  metrics: llmMetricsSchema.optional(),
});

export type LlmOutputNode = z.infer<typeof llmNodeSchema>;
export type LlmOutputRelationshipClaim = z.infer<
  typeof llmRelationshipClaimSchema
>;
export type LlmOutputAttributeClaim = z.infer<typeof llmAttributeClaimSchema>;
export type LlmOutputAlias = z.infer<typeof llmAliasSchema>;
export type LlmOutputMetrics = z.infer<typeof llmMetricsSchema>;
