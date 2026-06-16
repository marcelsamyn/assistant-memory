import { deriveSourceLabel } from "./source-label";
import { describe, expect, it } from "vitest";

describe("deriveSourceLabel", () => {
  it("uses an explicit title", () => {
    expect(
      deriveSourceLabel({ type: "document", metadata: { title: "Plan" } }),
    ).toBe("Plan");
  });

  it("falls back to filename when no title", () => {
    expect(
      deriveSourceLabel({ type: "document", metadata: { filename: "notes.md" } }),
    ).toBe("notes.md");
  });

  it("labels a chat message with role + first line", () => {
    expect(
      deriveSourceLabel({
        type: "conversation_message",
        metadata: { rawContent: "I'll send the report Friday\n(more)", role: "user" },
      }),
    ).toBe("User: I'll send the report Friday");
  });

  it("labels a chat message without a role using just the first line", () => {
    expect(
      deriveSourceLabel({
        type: "conversation_message",
        metadata: { rawContent: "hello there" },
      }),
    ).toBe("hello there");
  });

  it("returns null for a container source with no title", () => {
    expect(deriveSourceLabel({ type: "conversation", metadata: {} })).toBeNull();
  });

  it("returns null for a message with empty content", () => {
    expect(
      deriveSourceLabel({ type: "conversation_message", metadata: { rawContent: "   " } }),
    ).toBeNull();
  });
});
