import {
  contextualFileRevisionExternalId,
  contextualSourceExternalId,
} from "./source-identity";
import { describe, expect, it } from "vitest";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";

const partitionOne = contextPartitionKeySchema.parse("radar:one");
const partitionTwo = contextPartitionKeySchema.parse("radar:two");

describe("contextual source identity", () => {
  it("keeps a file identity stable when its bytes change", () => {
    const first = contextualFileRevisionExternalId({
      externalId: "attachment-42",
      accountId: "gmail-account",
      partitionKey: partitionOne,
      contentHash: "a".repeat(64),
    });
    const revised = contextualFileRevisionExternalId({
      externalId: "attachment-42",
      accountId: "gmail-account",
      partitionKey: partitionOne,
      contentHash: "b".repeat(64),
    });

    expect(revised).toBe(first);
  });

  it("separates the same provider id by account and destination partition", () => {
    const first = contextualSourceExternalId({
      externalId: "message-42",
      accountId: "gmail-a",
      partitionKey: partitionOne,
    });
    expect(
      contextualSourceExternalId({
        externalId: "message-42",
        accountId: "gmail-b",
        partitionKey: partitionOne,
      }),
    ).not.toBe(first);
    expect(
      contextualSourceExternalId({
        externalId: "message-42",
        accountId: "gmail-a",
        partitionKey: partitionTwo,
      }),
    ).not.toBe(first);
  });

  it("preserves legacy ids when no contextual namespace exists", () => {
    expect(contextualSourceExternalId({ externalId: "legacy-document" })).toBe(
      "legacy-document",
    );
  });
});
