import {
  ingestDocumentRequestSchema,
  ingestDocumentResponseSchema,
} from "./ingest-document-request";
import { ingestFileFieldsSchema } from "./ingest-file";
import { sourceContextSchema } from "./source-context";
import { describe, expect, it } from "vitest";

const context = {
  version: 1,
  sourceKind: "email" as const,
  purpose: "Find requests addressed to the account owner",
  accountId: "gmail-account-1",
  relationship: "recipient",
  sender: { email: "sender@example.com", name: "Sender" },
  recipients: [{ email: "marcel@example.com", name: "Marcel" }],
  direction: "incoming" as const,
  messageId: "provider-message-1",
  threadId: "provider-thread-1",
  sourceUrl: "https://mail.google.com/mail/u/0/#inbox/provider-message-1",
  authoredAt: "2026-09-10T08:00:00.000Z",
  chronology: {
    receivedAt: "2026-09-10T08:01:00.000Z",
    isLatestInThread: true,
  },
  currentMessageRole: "primary" as const,
  completeness: "complete" as const,
};

describe("source context contract", () => {
  it("round-trips through document and file ingestion requests", () => {
    expect(
      ingestDocumentRequestSchema.parse({
        userId: "user-1",
        document: {
          id: "message-1",
          content: "Please review",
          sourceContext: context,
        },
      }).document.sourceContext,
    ).toEqual(context);

    expect(
      ingestFileFieldsSchema.parse({
        userId: "user-1",
        filename: "attachment.pdf",
        mimeType: "application/pdf",
        sourceContext: { ...context, sourceKind: "email_attachment" },
      }).sourceContext,
    ).toEqual({ ...context, sourceKind: "email_attachment" });
  });

  it("rejects malformed context at the request boundary", () => {
    expect(() =>
      sourceContextSchema.parse({
        ...context,
        sourceKind: "email",
        purpose: "",
        completeness: "maybe",
      }),
    ).toThrow();
  });

  it("keeps the response additive for legacy callers", () => {
    expect(
      ingestDocumentResponseSchema.parse({
        message: "ok",
        jobId: "job-1",
        sourceId: "src_00000000000000000000000000",
      }),
    ).not.toHaveProperty("ingestionOperationId");
  });
});
