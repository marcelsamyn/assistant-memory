/** Predicate behavior registry. Common aliases: claim policy, lifecycle policy, retrieval section. */
import type { Predicate } from "~/types/graph";

export type Cardinality =
  | "single_current_value"
  | "multi_value"
  | "append_only";
export type LifecycleRule = "supersede_previous" | "none";
export type RetrievalSection =
  | "atlas"
  | "open_commitments"
  | "preferences"
  | "evidence"
  | "none";

export interface PredicatePolicy {
  predicate: Predicate;
  cardinality: Cardinality;
  lifecycle: LifecycleRule;
  feedsAtlas: boolean;
  retrievalSection: RetrievalSection;
  forceRefreshOnSupersede: boolean;
}

type PredicatePolicyMap = {
  [P in Predicate]: PredicatePolicy & { predicate: P };
};

export const PREDICATE_POLICIES = {
  HAS_STATUS: {
    predicate: "HAS_STATUS",
    cardinality: "single_current_value",
    lifecycle: "supersede_previous",
    feedsAtlas: true,
    retrievalSection: "atlas",
    forceRefreshOnSupersede: true,
  },
  HAS_TASK_STATUS: {
    predicate: "HAS_TASK_STATUS",
    cardinality: "single_current_value",
    lifecycle: "supersede_previous",
    feedsAtlas: false,
    retrievalSection: "open_commitments",
    forceRefreshOnSupersede: true,
  },
  HAS_PREFERENCE: {
    predicate: "HAS_PREFERENCE",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: true,
    retrievalSection: "preferences",
    forceRefreshOnSupersede: false,
  },
  HAS_GOAL: {
    predicate: "HAS_GOAL",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: true,
    retrievalSection: "preferences",
    forceRefreshOnSupersede: false,
  },
  MADE_DECISION: {
    predicate: "MADE_DECISION",
    cardinality: "append_only",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  PARTICIPATED_IN: {
    predicate: "PARTICIPATED_IN",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  OCCURRED_AT: {
    predicate: "OCCURRED_AT",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  OCCURRED_ON: {
    predicate: "OCCURRED_ON",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  INVOLVED_ITEM: {
    predicate: "INVOLVED_ITEM",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  EXHIBITED_EMOTION: {
    predicate: "EXHIBITED_EMOTION",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  TAGGED_WITH: {
    predicate: "TAGGED_WITH",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  OWNED_BY: {
    predicate: "OWNED_BY",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  DUE_ON: {
    predicate: "DUE_ON",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "open_commitments",
    forceRefreshOnSupersede: false,
  },
  PRECEDES: {
    predicate: "PRECEDES",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  FOLLOWS: {
    predicate: "FOLLOWS",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
  RELATED_TO: {
    predicate: "RELATED_TO",
    cardinality: "multi_value",
    lifecycle: "none",
    feedsAtlas: false,
    retrievalSection: "evidence",
    forceRefreshOnSupersede: false,
  },
} satisfies PredicatePolicyMap;
