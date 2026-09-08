import {
  contextPartitionKeySchema,
  reclassifySourcePartitionRequestSchema,
  setPartitionMigrationStateRequestSchema,
} from "./partition";
import { describe, expect, it } from "vitest";

describe("opaque memory partition schemas", () => {
  it("accepts caller-owned opaque keys without interpreting them", () => {
    expect(contextPartitionKeySchema.parse("tenant:42/ctx_A-7")).toBe(
      "tenant:42/ctx_A-7",
    );
  });

  it.each(["", " leading", "contains space", "a".repeat(201)])(
    "rejects an unsafe partition key: %j",
    (partitionKey) => {
      expect(() => contextPartitionKeySchema.parse(partitionKey)).toThrow();
    },
  );

  it("requires every compare-and-set fence on reclassification", () => {
    const base = {
      userId: "user_1",
      sourceId: "src_01kq54zhdye4a94mjmw0wev9jx",
      expectedPartitionKey: null,
      targetPartitionKey: "ctx:client-a",
      expectedSourceVersion: 0,
      bindingGeneration: "folder-binding:17",
    };

    expect(reclassifySourcePartitionRequestSchema.parse(base)).toEqual(base);
    for (const key of [
      "expectedPartitionKey",
      "targetPartitionKey",
      "expectedSourceVersion",
      "bindingGeneration",
    ] as const) {
      const withoutFence = Object.fromEntries(
        Object.entries(base).filter(([entryKey]) => entryKey !== key),
      );
      expect(() =>
        reclassifySourcePartitionRequestSchema.parse(withoutFence),
      ).toThrow();
    }
  });

  it("only permits forward migration state transitions", () => {
    expect(
      setPartitionMigrationStateRequestSchema.parse({
        userId: "user_1",
        expectedState: "unmigrated",
        expectedVersion: 0,
        nextState: "migrating",
      }),
    ).toBeDefined();
    expect(() =>
      setPartitionMigrationStateRequestSchema.parse({
        userId: "user_1",
        expectedState: "migrated",
        expectedVersion: 2,
        nextState: "unmigrated",
      }),
    ).toThrow();
  });

  it("requires an opaque unassigned destination when migration finishes", () => {
    const finishing = {
      userId: "user_1",
      expectedState: "migrating",
      expectedVersion: 2,
      nextState: "migrated",
    };
    expect(() =>
      setPartitionMigrationStateRequestSchema.parse(finishing),
    ).toThrow(/unassigned partition/i);
    expect(
      setPartitionMigrationStateRequestSchema.parse({
        ...finishing,
        unassignedPartitionKey: "opaque:unassigned",
      }),
    ).toBeDefined();
  });
});
