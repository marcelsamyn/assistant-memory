import { describe, expect, it } from "vitest";
import { _collectAttributeAffectedSubjectNodeIds } from "./extract-graph";
import type { claims } from "~/db/schema";
import { newTypeId, type TypeId } from "~/types/typeid";

type ClaimRow = typeof claims.$inferSelect;

function makeClaim(overrides: Partial<ClaimRow>): ClaimRow {
  return {
    id: newTypeId("claim"),
    userId: "user_1",
    subjectNodeId: newTypeId("node"),
    objectNodeId: null,
    objectValue: null,
    predicate: "RELATED_TO",
    statement: "test",
    description: null,
    metadata: null,
    sourceId: newTypeId("source"),
    scope: "personal",
    assertedByKind: "user",
    assertedByNodeId: null,
    supersededByClaimId: null,
    contradictedByClaimId: null,
    statedAt: new Date("2026-04-25T10:00:00.000Z"),
    validFrom: null,
    validTo: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ClaimRow;
}

describe("_collectAttributeAffectedSubjectNodeIds", () => {
  it("includes subjects of attribute-predicate inserts and deletes", () => {
    const subjectA = newTypeId("node");
    const subjectB = newTypeId("node");
    const inserted = [
      makeClaim({
        subjectNodeId: subjectA,
        predicate: "HAS_PREFERENCE",
        objectValue: "x",
      }),
    ];
    const deleted = [
      makeClaim({
        subjectNodeId: subjectB,
        predicate: "HAS_GOAL",
        objectValue: "y",
      }),
    ];
    const result = _collectAttributeAffectedSubjectNodeIds(inserted, deleted);
    expect(new Set(result)).toEqual(new Set<TypeId<"node">>([subjectA, subjectB]));
  });

  it("excludes subjects whose only changed claim is a relationship predicate", () => {
    const subjectRel = newTypeId("node");
    const inserted = [
      makeClaim({
        subjectNodeId: subjectRel,
        predicate: "RELATED_TO",
        objectNodeId: newTypeId("node"),
      }),
    ];
    const result = _collectAttributeAffectedSubjectNodeIds(inserted, []);
    expect(result).toEqual([]);
  });

  it("dedupes a subject that appears in both inserts and deletes", () => {
    const subject = newTypeId("node");
    const inserted = [
      makeClaim({
        subjectNodeId: subject,
        predicate: "HAS_STATUS",
        objectValue: "in_progress",
      }),
    ];
    const deleted = [
      makeClaim({
        subjectNodeId: subject,
        predicate: "HAS_STATUS",
        objectValue: "pending",
      }),
    ];
    const result = _collectAttributeAffectedSubjectNodeIds(inserted, deleted);
    expect(result).toEqual([subject]);
  });
});
