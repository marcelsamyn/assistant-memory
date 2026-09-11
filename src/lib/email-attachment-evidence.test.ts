import {
  formatEmailAttachmentEvidence,
  MAX_EMAIL_ATTACHMENT_CONTENT_CHARS,
  MAX_EMAIL_ATTACHMENT_PROMPT_CHARS,
} from "./email-attachment-evidence";
import { describe, expect, it } from "vitest";
import { newTypeId } from "~/types/typeid";

describe("email attachment prompt evidence", () => {
  it("keeps small converted evidence intact and marks it complete", () => {
    const attachment = {
      sourceId: newTypeId("source"),
      expectedSourceVersion: 1,
      content: "Review clause 7.",
    };
    const prompt = formatEmailAttachmentEvidence([attachment]);
    expect(prompt).toContain(
      JSON.stringify({
        sourceRef: attachment.sourceId,
        content: attachment.content,
        truncated: false,
      }),
    );
    expect(formatEmailAttachmentEvidence([])).toBe("");
  });

  it.each(["a", "\u0000", '\\"\n', "🪷"])(
    "bounds serialized evidence for large files and many attachments (%j)",
    (text) => {
      const attachments = Array.from({ length: 101 }, () => ({
        sourceId: newTypeId("source"),
        expectedSourceVersion: 1,
        content: text.repeat(100_000),
      }));
      const original = attachments[0]!.content;
      const prompt = formatEmailAttachmentEvidence(attachments);
      expect(prompt.length).toBeLessThanOrEqual(
        MAX_EMAIL_ATTACHMENT_PROMPT_CHARS,
      );
      expect(prompt).toContain('"truncated":true');
      expect(prompt).toContain(attachments[99]!.sourceId);
      expect(prompt).not.toContain(attachments[100]!.sourceId);
      expect(attachments[0]!.content).toBe(original);
    },
  );

  it("caps a single file prefix and retains loader truncation information", () => {
    const attachment = {
      sourceId: newTypeId("source"),
      expectedSourceVersion: 1,
      content: "a".repeat(MAX_EMAIL_ATTACHMENT_CONTENT_CHARS + 1),
    };
    const prompt = formatEmailAttachmentEvidence([attachment]);
    expect(prompt).toContain(
      JSON.stringify({
        sourceRef: attachment.sourceId,
        content: "a".repeat(MAX_EMAIL_ATTACHMENT_CONTENT_CHARS),
        truncated: true,
      }),
    );
    expect(
      formatEmailAttachmentEvidence([
        { ...attachment, content: "short stored prefix", truncated: true },
      ]),
    ).toContain('"truncated":true');
  });
});
