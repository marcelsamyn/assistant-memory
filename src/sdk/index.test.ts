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

  it("re-exports the digest, metric-movers, and recent-changes schemas", async () => {
    const sdk = await import("./index");
    expect(sdk.getDigestRequestSchema).toBeDefined();
    expect(sdk.getDigestResponseSchema).toBeDefined();
    expect(sdk.metricMoverSchema).toBeDefined();
    expect(sdk.queryRecentChangesResponseSchema).toBeDefined();
  });

  it("re-exports opaque partition migration contracts", async () => {
    const sdk = await import("./index");
    expect(sdk.contextPartitionKeySchema.parse("tenant:opaque/key")).toBe(
      "tenant:opaque/key",
    );
    expect(sdk.reclassifySourcePartitionRequestSchema).toBeDefined();
    expect(sdk.setPartitionMigrationStateRequestSchema).toBeDefined();
    expect(sdk.partitionInventoryResponseSchema).toBeDefined();
    expect(sdk.PartitionConflictError).toBeDefined();
    expect(sdk.PartitionMaintenanceUnavailableError).toBeDefined();
  });
});
