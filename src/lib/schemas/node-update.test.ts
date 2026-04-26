import { updateNodeRequestSchema } from "./node";
import { describe, expect, it } from "vitest";

describe("updateNodeRequestSchema", () => {
  it("does not expose description updates", () => {
    expect("description" in updateNodeRequestSchema.shape).toBe(false);
  });
});
