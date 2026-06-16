import { sourceContentFromRaw, TEXT_BLOB_MAX_BYTES } from "./source-content";
import { describe, expect, it } from "vitest";

describe("sourceContentFromRaw", () => {
  it("returns inline content with markdown format for documents", () => {
    expect(
      sourceContentFromRaw(
        { kind: "inline", sourceId: "src_x", content: "hi" },
        "document",
      ),
    ).toEqual({ text: "hi", format: "markdown" });
  });

  it("returns inline content with text format for non-documents", () => {
    expect(
      sourceContentFromRaw(
        { kind: "inline", sourceId: "src_x", content: "hi" },
        "conversation_message",
      ),
    ).toEqual({ text: "hi", format: "text" });
  });

  it("decodes a text/markdown blob within the size cap", () => {
    expect(
      sourceContentFromRaw(
        {
          kind: "blob",
          sourceId: "src_x",
          buffer: Buffer.from("# Heading\nbody", "utf-8"),
          contentType: "text/markdown",
        },
        "document",
      ),
    ).toEqual({ text: "# Heading\nbody", format: "markdown" });
  });

  it("returns null for a binary blob", () => {
    expect(
      sourceContentFromRaw(
        {
          kind: "blob",
          sourceId: "src_x",
          buffer: Buffer.from([0, 1, 2]),
          contentType: "application/pdf",
        },
        "document",
      ),
    ).toBeNull();
  });

  it("returns null for a text blob over the size cap", () => {
    expect(
      sourceContentFromRaw(
        {
          kind: "blob",
          sourceId: "src_x",
          buffer: Buffer.alloc(TEXT_BLOB_MAX_BYTES + 1, 0x61),
          contentType: "text/plain",
        },
        "document",
      ),
    ).toBeNull();
  });

  it("returns null when there is no payload", () => {
    expect(sourceContentFromRaw(undefined, "document")).toBeNull();
  });
});
