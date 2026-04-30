/**
 * SDK surface assertions. Catches accidental drops/renames of public exports.
 */
import { describe, expect, it } from "vitest";

describe("SDK exports", () => {
  it("re-exports userProfileMetadataSchema", async () => {
    const sdk = await import("./index");
    expect(sdk.userProfileMetadataSchema).toBeDefined();
    const parsed = sdk.userProfileMetadataSchema.parse({
      userSelfAliases: ["Marcel"],
    });
    expect(parsed.userSelfAliases).toEqual(["Marcel"]);
  });
});
