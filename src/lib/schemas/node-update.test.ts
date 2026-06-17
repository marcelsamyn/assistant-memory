import { updateNodeRequestSchema } from "./node";
import { describe, expect, it } from "vitest";
import { newTypeId } from "~/types/typeid";

describe("updateNodeRequestSchema", () => {
  it("accepts an optional description override", () => {
    expect("description" in updateNodeRequestSchema.shape).toBe(true);

    const parsed = updateNodeRequestSchema.parse({
      userId: "user_A",
      nodeId: newTypeId("node"),
      description: "User-corrected summary",
    });
    expect(parsed.description).toBe("User-corrected summary");
  });

  it("treats an omitted description as no change and accepts an empty string to clear", () => {
    const base = { userId: "user_A", nodeId: newTypeId("node") };
    expect(updateNodeRequestSchema.parse(base).description).toBeUndefined();
    expect(
      updateNodeRequestSchema.parse({ ...base, description: "" }).description,
    ).toBe("");
  });
});
