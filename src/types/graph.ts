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

export const EdgeTypeEnum = z.enum([
  "PARTICIPATED_IN",
  "OCCURRED_AT",
  "OCCURRED_ON",
  "INVOLVED_ITEM",
  "EXHIBITED_EMOTION",
  "TAGGED_WITH",
  "OWNED_BY",
  "MENTIONED_IN",
  "PRECEDES",
  "FOLLOWS",
  "RELATED_TO",
  "CAPTURED_IN",
  "INVALIDATED_ON",
]);

export type EdgeType = z.infer<typeof EdgeTypeEnum>;

// =============================================================
// CLAIM PREDICATES & STATUS
// =============================================================
// Claims-first memory layer (see docs/2026-04-24-claims-layer-design.md).
// `EdgeTypeEnum` is retained for transitional code paths and is scheduled
// for removal in PR 1b once all consumers have been migrated to claims.

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
