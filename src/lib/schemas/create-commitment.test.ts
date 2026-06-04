import { newTypeId } from "../../types/typeid";
import { createCommitmentRequestSchema } from "./create-commitment";
import { describe, expect, it } from "vitest";

describe("createCommitmentRequestSchema", () => {
  it("defaults status to pending when omitted", () => {
    const parsed = createCommitmentRequestSchema.parse({
      userId: "user_1",
      label: "Send the spec",
    });
    expect(parsed.status).toBe("pending");
    expect(parsed.dueOn).toBeUndefined();
    expect(parsed.ownedBy).toBeUndefined();
  });

  it("accepts in_progress as an open status", () => {
    const parsed = createCommitmentRequestSchema.parse({
      userId: "user_1",
      label: "Migrate the worker",
      status: "in_progress",
    });
    expect(parsed.status).toBe("in_progress");
  });

  it("rejects done and abandoned — a commitment opens only as pending or in_progress", () => {
    for (const status of ["done", "abandoned"]) {
      expect(() =>
        createCommitmentRequestSchema.parse({
          userId: "user_1",
          label: "x",
          status,
        }),
      ).toThrow();
    }
  });

  it("requires a non-empty label", () => {
    expect(() =>
      createCommitmentRequestSchema.parse({ userId: "user_1", label: "" }),
    ).toThrow();
  });

  it("accepts a YYYY-MM-DD due date and rejects other formats", () => {
    expect(
      createCommitmentRequestSchema.parse({
        userId: "user_1",
        label: "x",
        dueOn: "2026-06-06",
      }).dueOn,
    ).toBe("2026-06-06");
    expect(() =>
      createCommitmentRequestSchema.parse({
        userId: "user_1",
        label: "x",
        dueOn: "2026/06/06",
      }),
    ).toThrow();
  });

  it("accepts an owner node id", () => {
    const ownedBy = newTypeId("node");
    expect(
      createCommitmentRequestSchema.parse({
        userId: "user_1",
        label: "x",
        ownedBy,
      }).ownedBy,
    ).toBe(ownedBy);
  });
});
