import { PREDICATE_POLICIES } from "./predicate-policies";
import { describe, expect, it } from "vitest";
import {
  AttributePredicateEnum,
  RelationshipPredicateEnum,
} from "~/types/graph";

describe("PREDICATE_POLICIES", () => {
  it("has one policy for every predicate", () => {
    const predicates = [
      ...AttributePredicateEnum.options,
      ...RelationshipPredicateEnum.options,
    ].sort();

    expect(Object.keys(PREDICATE_POLICIES).sort()).toEqual(predicates);
  });

  it("keeps single-current predicates lifecycle-backed", () => {
    const singleCurrentPolicies = Object.values(PREDICATE_POLICIES).filter(
      (policy) => policy.cardinality === "single_current_value",
    );

    expect(singleCurrentPolicies.length).toBeGreaterThan(0);
    expect(
      singleCurrentPolicies.every(
        (policy) => policy.lifecycle === "supersede_previous",
      ),
    ).toBe(true);
  });

  it("routes task status to open commitments", () => {
    expect(PREDICATE_POLICIES.HAS_TASK_STATUS).toMatchObject({
      cardinality: "single_current_value",
      lifecycle: "supersede_previous",
      feedsAtlas: false,
      retrievalSection: "open_commitments",
      forceRefreshOnSupersede: true,
    });
  });
});
