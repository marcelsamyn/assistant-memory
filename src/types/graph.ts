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

export const AttributePredicateEnum = z.enum([
  "HAS_STATUS",
  "HAS_PREFERENCE",
  "HAS_GOAL",
  "MADE_DECISION",
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
  "PRECEDES",
  "FOLLOWS",
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
  | "manual";

export type SourceStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "summarized";
