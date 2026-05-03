/**
 * Public re-exports of graph enums for SDK consumers.
 *
 * Internal code imports from `~/types/graph` directly; this module exists so
 * `@marcelsamyn/memory/sdk` consumers don't have to reach into a `types/`
 * path that isn't part of the SDK surface.
 *
 * When an attribute predicate has an implied vocabulary that the server
 * validates (e.g. `HAS_TASK_STATUS` → `TaskStatusEnum`), exposing that enum
 * here lets clients align their own write paths with the canonical set
 * instead of inventing their own ("done" vs "completed", etc.).
 */
export {
  AssertedByKindEnum,
  AttributePredicateEnum,
  ClaimStatusEnum,
  NodeTypeEnum,
  PredicateEnum,
  RelationshipPredicateEnum,
  ScopeEnum,
  TaskStatusEnum,
  type AssertedByKind,
  type AttributePredicate,
  type ClaimStatus,
  type NodeType,
  type Predicate,
  type RelationshipPredicate,
  type Scope,
  type TaskStatus,
} from "../../types/graph.js";
