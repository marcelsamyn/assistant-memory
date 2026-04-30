import { describe, expect, it } from "vitest";
import {
  type ClaimResponse,
  claimResponseSchema,
  createClaimResponseSchema,
} from "~/lib/schemas/claim";
import { newTypeId } from "~/types/typeid";

const claim = {
  id: newTypeId("claim"),
  userId: "user_A",
  subjectNodeId: newTypeId("node"),
  objectNodeId: newTypeId("node"),
  objectValue: null,
  predicate: "RELATED_TO",
  statement: "Marcel is related to Assistant Memory.",
  description: null,
  sourceId: newTypeId("source"),
  scope: "personal",
  assertedByKind: "user",
  assertedByNodeId: null,
  supersededByClaimId: null,
  contradictedByClaimId: null,
  statedAt: new Date("2026-04-30T09:00:00.000Z"),
  validFrom: null,
  validTo: null,
  status: "active",
  createdAt: new Date("2026-04-30T09:00:00.000Z"),
  updatedAt: new Date("2026-04-30T09:00:00.000Z"),
} satisfies ClaimResponse["claim"];

describe("claim schemas", () => {
  it("requires node labels on create responses", () => {
    expect(() => createClaimResponseSchema.parse({ claim })).toThrow();

    const parsed = createClaimResponseSchema.parse({
      claim: {
        ...claim,
        subjectLabel: "Marcel",
        objectLabel: "Assistant Memory",
      },
    });

    expect(parsed.claim.subjectLabel).toBe("Marcel");
    expect(parsed.claim.objectLabel).toBe("Assistant Memory");
  });

  it("keeps generic claim responses label-free", () => {
    expect(claimResponseSchema.parse({ claim }).claim.id).toBe(claim.id);
  });
});
