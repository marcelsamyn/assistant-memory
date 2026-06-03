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
