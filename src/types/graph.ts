import { z } from "zod";

// =============================================================
// BASE ENUMS
// =============================================================

export const NodeTypeEnum = z.enum([
  "Person",
  "Location",
  "Event",
  "Object",
  "Emotion",
  "Concept",
  "Media",
  "Temporal",
  "Conversation",
  "Atlas",
  "AssistantDream",
  "Document",
  "Feedback",
  "Idea",
  "Task",
]);

export type NodeType = z.infer<typeof NodeTypeEnum>;

/**
 * Node types the graph extractor is allowed to mint. A strict subset of
 * `NodeTypeEnum` that omits structural / system-owned types — `Document` and
 * `Conversation` are created by ingestion, `Atlas` and `AssistantDream` by the
 * atlas/dream subsystems. Offering them to the LLM caused stray `Atlas` and
 * `Document` nodes, so the extraction schema uses this narrower set.
 */
export const ExtractionNodeTypeEnum = z.enum([
  "Person",
  "Location",
  "Event",
  "Object",
  "Emotion",
  "Concept",
  "Media",
  "Temporal",
  "Feedback",
  "Idea",
  "Task",
]);

export type ExtractionNodeType = z.infer<typeof ExtractionNodeTypeEnum>;

/**
 * Node types whose canonical label denotes a single real-world referent, so
 * two same-typed nodes that share a label are safe to collapse automatically.
 * Both automatic merge paths — the deterministic dedup-sweep and the
 * operations applied by the LLM graph cleanup — consult this set before
 * merging by label.
 *
 * Record / occurrence types are deliberately excluded: `Task`, `Event`,
 * `Idea`, `Document`, `Conversation`, `AssistantDream`, `Feedback`, and
 * `Atlas` nodes can legitimately recur with identical labels (a task created
 * for each day of the week, a weekly standup `Event`, two distinct files named
 * "notes.md"). Collapsing those by label alone destroys distinct instances —
 * e.g. completing one daily task would complete the merged node for every day.
 * Explicit, user-initiated merges (the `/node/merge` route) are not gated by
 * this set; only the automatic paths are.
 */
export const LABEL_MERGEABLE_NODE_TYPES = [
  "Person",
  "Location",
  "Object",
  "Emotion",
  "Concept",
  "Media",
  "Temporal",
] as const satisfies readonly NodeType[];

const labelMergeableNodeTypeSet: ReadonlySet<string> = new Set(
  LABEL_MERGEABLE_NODE_TYPES,
);

/**
 * Whether nodes of `nodeType` may be merged automatically when their canonical
 * labels match. Returns `false` for unknown types so anything outside the
 * vetted entity set is treated as a distinct record and left untouched.
 */
export function isLabelMergeableNodeType(nodeType: string): boolean {
  return labelMergeableNodeTypeSet.has(nodeType);
}

// =============================================================
// CLAIM PREDICATES & STATUS
// =============================================================

export const ClaimStatusEnum = z.enum([
  "active",
  "superseded",
  "contradicted",
  "retracted",
]);

export type ClaimStatus = z.infer<typeof ClaimStatusEnum>;

export const ScopeEnum = z.enum(["personal", "reference"]);

export type Scope = z.infer<typeof ScopeEnum>;

export const AssertedByKindEnum = z.enum([
  "user",
  "user_confirmed",
  "assistant_inferred",
  "participant",
  "document_author",
  "system",
]);

export type AssertedByKind = z.infer<typeof AssertedByKindEnum>;

export const TaskStatusEnum = z.enum([
  "pending",
  "in_progress",
  "done",
  "abandoned",
]);

export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const AttributePredicateEnum = z.enum([
  "HAS_STATUS",
  "HAS_TASK_STATUS",
  "HAS_PREFERENCE",
  "HAS_GOAL",
  "MADE_DECISION",
  // Generic property of an entity, with the value in `objectValue`. Keeps
  // scalar facts ("38 employees", "headquartered in Stockholm") from being
  // reified into standalone value-nodes linked by RELATED_TO.
  "HAS_ATTRIBUTE",
]);

export type AttributePredicate = z.infer<typeof AttributePredicateEnum>;

export const RelationshipPredicateEnum = z.enum([
  "PARTICIPATED_IN",
  "OCCURRED_AT",
  "OCCURRED_ON",
  "INVOLVED_ITEM",
  "EXHIBITED_EMOTION",
  "TAGGED_WITH",
  "OWNED_BY",
  "DUE_ON",
  "PRECEDES",
  "FOLLOWS",
  // World-knowledge relationships for document / reference content. Without
  // these, document facts (employment, founding, location, authorship, usage,
  // composition) have no specific predicate and collapse onto RELATED_TO.
  "WORKS_AT",
  "FOUNDED",
  "CREATED",
  "LOCATED_IN",
  "PART_OF",
  "USES",
  "AFFILIATED_WITH",
  // Catch-all — last resort only, when no specific predicate fits.
  "RELATED_TO",
]);

export type RelationshipPredicate = z.infer<typeof RelationshipPredicateEnum>;

export const PredicateEnum = z.union([
  AttributePredicateEnum,
  RelationshipPredicateEnum,
]);

export type Predicate = z.infer<typeof PredicateEnum>;

export type SourceType =
  | "conversation"
  | "conversation_message"
  | "document"
  | "legacy_migration"
  | "manual"
  | "meeting_transcript"
  | "external_conversation"
  | "metric_push"
  | "metric_manual";

export type SourceStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "summarized";
