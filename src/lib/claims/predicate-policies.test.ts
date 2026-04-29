import {
  PREDICATE_POLICIES,
  resolvePredicatePolicy,
} from "./predicate-policies";
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

  it("keeps subject-type overrides lifecycle-backed", () => {
    for (const entry of Object.values(PREDICATE_POLICIES)) {
      const overrides = entry.subjectTypeOverrides;
      if (overrides === undefined) continue;
      for (const override of Object.values(overrides)) {
        if (override === undefined) continue;
        if (override.cardinality === "single_current_value") {
          expect(override.lifecycle).toBe("supersede_previous");
        }
      }
    }
  });
});

describe("resolvePredicatePolicy", () => {
  it("returns the base policy when no subject-type override exists", () => {
    expect(resolvePredicatePolicy("HAS_PREFERENCE", "Person")).toMatchObject({
      cardinality: "multi_value",
      lifecycle: "none",
    });
  });

  it("returns the base policy for unknown / null subject type", () => {
    expect(resolvePredicatePolicy("OWNED_BY", null)).toMatchObject({
      cardinality: "multi_value",
      lifecycle: "none",
    });
    expect(resolvePredicatePolicy("DUE_ON", null)).toMatchObject({
      cardinality: "multi_value",
      lifecycle: "none",
    });
  });

  it("upgrades OWNED_BY on Task subjects to single_current_value", () => {
    expect(resolvePredicatePolicy("OWNED_BY", "Task")).toMatchObject({
      predicate: "OWNED_BY",
      cardinality: "single_current_value",
      lifecycle: "supersede_previous",
      feedsAtlas: false,
      retrievalSection: "evidence",
      forceRefreshOnSupersede: false,
    });
  });

  it("upgrades DUE_ON on Task subjects to single_current_value", () => {
    expect(resolvePredicatePolicy("DUE_ON", "Task")).toMatchObject({
      predicate: "DUE_ON",
      cardinality: "single_current_value",
      lifecycle: "supersede_previous",
      retrievalSection: "open_commitments",
    });
  });

  it("preserves multi_value OWNED_BY for non-Task subjects", () => {
    expect(resolvePredicatePolicy("OWNED_BY", "Concept")).toMatchObject({
      cardinality: "multi_value",
      lifecycle: "none",
    });
    expect(resolvePredicatePolicy("OWNED_BY", "Atlas")).toMatchObject({
      cardinality: "multi_value",
      lifecycle: "none",
    });
  });

  it("leaves predicates without overrides unchanged across subject types", () => {
    expect(resolvePredicatePolicy("HAS_TASK_STATUS", "Task")).toMatchObject({
      cardinality: "single_current_value",
      lifecycle: "supersede_previous",
    });
    expect(resolvePredicatePolicy("HAS_STATUS", "Concept")).toMatchObject({
      cardinality: "single_current_value",
      lifecycle: "supersede_previous",
    });
  });
});
