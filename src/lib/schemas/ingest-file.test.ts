import { ingestFileFieldsSchema } from "./ingest-file";
import { describe, it, expect } from "vitest";

describe("ingestFileFieldsSchema", () => {
  it("defaults scope to personal and leaves optionals undefined", () => {
    const parsed = ingestFileFieldsSchema.parse({
      userId: "u1",
      filename: "doc.pdf",
      mimeType: "application/pdf",
    });
    expect(parsed.scope).toBe("personal");
    expect(parsed.title).toBeUndefined();
    expect(parsed.author).toBeUndefined();
    expect(parsed.timestamp).toBeUndefined();
  });

  it("accepts author/title and coerces timestamp to a Date", () => {
    const iso = "2025-04-01T10:00:00.000Z";
    const parsed = ingestFileFieldsSchema.parse({
      userId: "u1",
      filename: "book.epub",
      mimeType: "application/epub+zip",
      title: "How To Memory",
      author: "Jane Doe",
      timestamp: iso,
      scope: "reference",
    });
    expect(parsed.author).toBe("Jane Doe");
    expect(parsed.title).toBe("How To Memory");
    expect(parsed.scope).toBe("reference");
    expect(parsed.timestamp).toBeInstanceOf(Date);
    expect(parsed.timestamp?.toISOString()).toBe(iso);
  });

  it("rejects empty-string author/title and non-ISO timestamps", () => {
    expect(() =>
      ingestFileFieldsSchema.parse({
        userId: "u1",
        filename: "x.pdf",
        mimeType: "application/pdf",
        author: "",
      }),
    ).toThrow();

    expect(() =>
      ingestFileFieldsSchema.parse({
        userId: "u1",
        filename: "x.pdf",
        mimeType: "application/pdf",
        timestamp: "yesterday",
      }),
    ).toThrow();
  });
});
