import {
  contextualFileRevisionExternalId,
  contextualSourceExternalId,
  reclassifyContextualSourceExternalId,
} from "./source-identity";
import { describe, expect, it } from "vitest";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { contextualSourceExternalId as sdkContextualSourceExternalId } from "~/sdk/index";

const partitionOne = contextPartitionKeySchema.parse("radar:one");
const partitionTwo = contextPartitionKeySchema.parse("radar:two");

describe("contextual source identity", () => {
  it("exports the same canonical identity contract to SDK lifecycle callers", () => {
    const identity = {
      externalId: "message:42/é",
      accountId: "gmail:account",
      partitionKey: partitionOne,
    };
    expect(sdkContextualSourceExternalId(identity)).toBe(
      "context:Z21haWw6YWNjb3VudA:cmFkYXI6b25l:bWVzc2FnZTo0Mi_DqQ",
    );
    expect(sdkContextualSourceExternalId(identity)).toBe(
      contextualSourceExternalId(identity),
    );
  });

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
  it("rekeys only canonical identities with matching validated context", () => {
    const sourceContext = {
      version: 1,
      sourceKind: "email",
      purpose: "Read requests",
      accountId: "account",
      relationship: "recipient",
      currentMessageRole: "current",
      completeness: "complete",
    };
    const externalId = contextualSourceExternalId({
      externalId: "provider:é",
      accountId: "account",
      partitionKey: partitionOne,
    });
    const input = {
      externalId,
      metadata: { sourceContext },
      expectedPartitionKey: partitionOne,
      targetPartitionKey: partitionTwo,
    };
    expect(reclassifyContextualSourceExternalId(input)).toBe(
      contextualSourceExternalId({
        externalId: "provider:é",
        accountId: "account",
        partitionKey: partitionTwo,
      }),
    );
    expect(
      reclassifyContextualSourceExternalId({ ...input, metadata: {} }),
    ).toBe(externalId);
    expect(
      reclassifyContextualSourceExternalId({
        ...input,
        metadata: { sourceContext: { accountId: "account" } },
      }),
    ).toBe(externalId);
    expect(
      reclassifyContextualSourceExternalId({
        ...input,
        expectedPartitionKey: partitionTwo,
      }),
    ).toBe(externalId);
    expect(
      reclassifyContextualSourceExternalId({
        ...input,
        externalId: "legacy-id",
      }),
    ).toBe("legacy-id");
  });
});
