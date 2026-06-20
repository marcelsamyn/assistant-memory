import {
  assertRelationshipPredicateShape,
  assertRelationshipPredicateShapeCoverage,
  formatRelationshipPredicateGuide,
  isInvalidRelationshipPredicateClaimShape,
  isRelationshipPredicateShapeAllowed,
} from "./predicate-shapes";
import { describe, expect, it } from "vitest";

describe("relationship predicate shapes", () => {
  it("covers every relationship predicate", () => {
    expect(() => assertRelationshipPredicateShapeCoverage()).not.toThrow();
  });

  it("rejects predicates whose node types do not match their domain and range", () => {
    expect(() =>
      assertRelationshipPredicateShape({
        predicate: "DUE_ON",
        subjectType: "Person",
        objectType: "Person",
      }),
    ).toThrow("Invalid DUE_ON relationship shape");

    expect(() =>
      assertRelationshipPredicateShape({
        predicate: "LOCATED_IN",
        subjectType: "Person",
        objectType: "Object",
      }),
    ).toThrow("Invalid LOCATED_IN relationship shape");

    expect(() =>
      assertRelationshipPredicateShape({
        predicate: "EXHIBITED_EMOTION",
        subjectType: "Person",
        objectType: "Media",
      }),
    ).toThrow("Invalid EXHIBITED_EMOTION relationship shape");
  });

  it("uses active ownership direction and task assignment as separate shapes", () => {
    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "OWNS",
        subjectType: "Person",
        objectType: "Object",
      }),
    ).toBe(true);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "OWNS",
        subjectType: "Object",
        objectType: "Person",
      }),
    ).toBe(false);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "ASSIGNED_TO",
        subjectType: "Task",
        objectType: "Person",
      }),
    ).toBe(true);
  });

  it("treats formal organizations and named groups as first-class entities", () => {
    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "WORKS_AT",
        subjectType: "Person",
        objectType: "Organization",
      }),
    ).toBe(true);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "AFFILIATED_WITH",
        subjectType: "Person",
        objectType: "Organization",
      }),
    ).toBe(true);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "OWNS",
        subjectType: "Organization",
        objectType: "Organization",
      }),
    ).toBe(true);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "LOCATED_IN",
        subjectType: "Organization",
        objectType: "Location",
      }),
    ).toBe(true);
  });

  it("classifies relationship object-value rows as invalid without rejecting attributes", () => {
    expect(
      isInvalidRelationshipPredicateClaimShape({
        predicate: "RELATED_TO",
        subjectType: "Person",
        objectType: null,
      }),
    ).toBe(true);

    expect(
      isInvalidRelationshipPredicateClaimShape({
        predicate: "HAS_PREFERENCE",
        subjectType: "Person",
        objectType: null,
      }),
    ).toBe(false);
  });

  it("separates real-world occurrence dates from recorded bookkeeping dates", () => {
    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "OCCURRED_ON",
        subjectType: "Person",
        objectType: "Temporal",
      }),
    ).toBe(false);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "RECORDED_ON",
        subjectType: "Person",
        objectType: "Temporal",
      }),
    ).toBe(true);

    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "RECORDED_ON",
        subjectType: "Temporal",
        objectType: "Temporal",
      }),
    ).toBe(false);
  });

  it("keeps RELATED_TO available as an explicit fallback without restoring OWNED_BY", () => {
    expect(
      isRelationshipPredicateShapeAllowed({
        predicate: "RELATED_TO",
        subjectType: "Person",
        objectType: "Object",
      }),
    ).toBe(true);

    const guide = formatRelationshipPredicateGuide();
    expect(guide).toContain("RELATED_TO");
    expect(guide).toContain("RECORDED_ON");
    expect(guide).toContain("OWNS");
    expect(guide).toContain("ASSIGNED_TO");
    expect(guide).not.toContain("OWNED_BY");
  });
});
