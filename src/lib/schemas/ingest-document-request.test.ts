import { ingestDocumentRequestSchema } from "./ingest-document-request";
import { describe, it, expect } from "vitest";

describe("ingestDocumentRequestSchema", () => {
  it("defaults updateExisting to false", () => {
    const parsed = ingestDocumentRequestSchema.parse({
      userId: "u1",
      document: { id: "d1", content: "text" },
    });
    expect(parsed.updateExisting).toBe(false);
    expect(parsed.document.scope).toBe("personal");
  });

  it("allows updateExisting true and reference scope", () => {
    const parsed = ingestDocumentRequestSchema.parse({
      userId: "u1",
      updateExisting: true,
      document: { id: "d1", content: "text", scope: "reference" },
    });
    expect(parsed.updateExisting).toBe(true);
    expect(parsed.document.scope).toBe("reference");
  });

  it("accepts optional author/title for reference attribution", () => {
    const parsed = ingestDocumentRequestSchema.parse({
      userId: "u1",
      document: {
        id: "d1",
        content: "text",
        scope: "reference",
        author: "Jane Doe",
        title: "How To Memory",
      },
    });
    expect(parsed.document.author).toBe("Jane Doe");
    expect(parsed.document.title).toBe("How To Memory");
  });

  it("rejects empty-string author/title", () => {
    expect(() =>
      ingestDocumentRequestSchema.parse({
        userId: "u1",
        document: { id: "d1", content: "text", author: "" },
      }),
    ).toThrow();
  });

  it("defaults contentType to markdown and accepts html", () => {
    const md = ingestDocumentRequestSchema.parse({
      userId: "u1",
      document: { id: "d1", content: "text" },
    });
    expect(md.document.contentType).toBe("markdown");

    const html = ingestDocumentRequestSchema.parse({
      userId: "u1",
      document: { id: "d2", content: "<p>hi</p>", contentType: "html" },
    });
    expect(html.document.contentType).toBe("html");
  });

  it("rejects unknown contentType values", () => {
    expect(() =>
      ingestDocumentRequestSchema.parse({
        userId: "u1",
        document: { id: "d1", content: "text", contentType: "xml" },
      }),
    ).toThrow();
  });
});
