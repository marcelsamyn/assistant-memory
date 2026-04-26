import { createAliasRequestSchema } from "./alias";
import { describe, expect, it } from "vitest";

describe("createAliasRequestSchema", () => {
  it("rejects empty alias text after trimming", () => {
    const result = createAliasRequestSchema.safeParse({
      userId: "user_A",
      canonicalNodeId: "node_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      aliasText: "   ",
    });

    expect(result.success).toBe(false);
  });
});
