/**
 * NodeCard read model — the per-entity unit returned by `getEntityContext`,
 * `searchMemory`, and `searchReference` (Phase 3 of the claims layer plan).
 *
 * Shape follows `docs/2026-04-24-claims-layer-design.md` section "Node card
 * shape". A card collapses the active claim set for a single node into the
 * shape an LLM consumes: a summary plus rendered fact groups plus evidence
 * refs. Raw claim data is intentionally only exposed through `recentEvidence`.
 *
 * Common aliases: NodeCard, entity card, get_entity output, node card shape.
 */
import { claimEvidenceSchema } from "./types.js";
import { z } from "zod";
import { openCommitmentSchema } from "~/lib/schemas/open-commitments.js";
import {
  AttributePredicateEnum,
  NodeTypeEnum,
  PredicateEnum,
  ScopeEnum,
} from "~/types/graph.js";
import { typeIdSchema } from "~/types/typeid.js";

/**
 * Active `single_current_value` attribute claim about the node, plus any
 * relationship claim whose policy resolves to single_current_value for the
 * subject's type (e.g. OWNED_BY on a Task). Either an `objectValue` (attribute)
 * or an `objectNodeId` + resolved `objectLabel` (relationship) is set; the
 * other column is null. The `(predicate, subjectType)` policy gate happens in
 * `node-card.ts`.
 */
export const nodeCardCurrentFactSchema = z.object({
  predicate: PredicateEnum,
  objectValue: z.string().nullable(),
  objectNodeId: typeIdSchema("node").nullable(),
  objectLabel: z.string().nullable(),
  statement: z.string(),
  statedAt: z.coerce.date(),
  evidence: claimEvidenceSchema,
});
export type NodeCardCurrentFact = z.infer<typeof nodeCardCurrentFactSchema>;

/**
 * Active `multi_value` attribute claim that feeds the user portrait
 * (`HAS_PREFERENCE`, `HAS_GOAL`). Restricted to attribute predicates because
 * preferencesGoals is an attribute-only section per the design's preferences
 * filter rule.
 */
export const nodeCardPreferenceGoalSchema = z.object({
  predicate: AttributePredicateEnum,
  objectValue: z.string().nullable(),
  statement: z.string(),
  statedAt: z.coerce.date(),
  evidence: claimEvidenceSchema,
});
export type NodeCardPreferenceGoal = z.infer<
  typeof nodeCardPreferenceGoalSchema
>;

/**
 * Compact recent evidence row — top-N active claims for the node ordered by
 * `statedAt desc`, exposed as statement + sourceId per the design.
 */
export const nodeCardRecentEvidenceSchema = z.object({
  statement: z.string(),
  sourceId: typeIdSchema("source"),
  statedAt: z.coerce.date(),
});
export type NodeCardRecentEvidence = z.infer<
  typeof nodeCardRecentEvidenceSchema
>;

/**
 * Reference metadata for `scope === 'reference'` nodes. Pulled from the
 * source(s) backing the node via `sourceLinks`. Both fields are individually
 * optional because reference documents may carry one without the other.
 */
export const nodeCardReferenceSchema = z.object({
  author: z.string().nullable(),
  title: z.string().nullable(),
});
export type NodeCardReference = z.infer<typeof nodeCardReferenceSchema>;

export const nodeCardSchema = z.object({
  nodeId: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string(),
  aliases: z.array(z.string()),
  scope: ScopeEnum,
  summary: z.string().nullable(),
  currentFacts: z.array(nodeCardCurrentFactSchema),
  preferencesGoals: z.array(nodeCardPreferenceGoalSchema),
  openCommitments: z.array(openCommitmentSchema).optional(),
  recentEvidence: z.array(nodeCardRecentEvidenceSchema),
  reference: nodeCardReferenceSchema.optional(),
});
export type NodeCard = z.infer<typeof nodeCardSchema>;
