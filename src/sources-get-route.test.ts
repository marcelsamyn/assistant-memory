import handler from "./routes/sources/get.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSummary } from "~/lib/schemas/sources";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  fetchRaw: vi.fn(),
  getSourceSummary: vi.fn(),
}));

vi.mock("~/lib/sources", () => ({
  sourceService: { fetchRaw: mocks.fetchRaw },
}));

vi.mock("~/lib/sources-read", () => ({
  getSourceSummary: mocks.getSourceSummary,
}));

vi.mock("~/utils/db", () => ({
  useDatabase: async (): Promise<unknown> => ({}),
}));

describe("POST /sources/get", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not fetch or return content by default", async () => {
    const source = makeSourceSummary("document");
    vi.stubGlobal("readBody", async () => ({
      userId: "user_source",
      sourceId: source.sourceId,
    }));
    mocks.getSourceSummary.mockResolvedValue(source);

    const response = await handler({} as H3Event);

    expect(mocks.fetchRaw).not.toHaveBeenCalled();
    expect(response.source).toEqual(source);
    expect(response.source).not.toHaveProperty("content");
  });

  it("returns stored document text as markdown when requested", async () => {
    const source = makeSourceSummary("document");
    vi.stubGlobal("readBody", async () => ({
      userId: "user_source",
      sourceId: source.sourceId,
      includeContent: true,
    }));
    mocks.getSourceSummary.mockResolvedValue(source);
    mocks.fetchRaw.mockResolvedValue([
      {
        kind: "inline",
        sourceId: source.sourceId,
        content: "# Stored markdown",
      },
    ]);

    const response = await handler({} as H3Event);

    expect(mocks.fetchRaw).toHaveBeenCalledWith("user_source", [
      source.sourceId,
    ]);
    expect(response.source.content).toEqual({
      text: "# Stored markdown",
      format: "markdown",
    });
  });

  it("returns null content instead of decoding a blob", async () => {
    const source = makeSourceSummary("document");
    vi.stubGlobal("readBody", async () => ({
      userId: "user_source",
      sourceId: source.sourceId,
      includeContent: true,
    }));
    mocks.getSourceSummary.mockResolvedValue(source);
    mocks.fetchRaw.mockResolvedValue([
      {
        kind: "blob",
        sourceId: source.sourceId,
        buffer: Buffer.from("binary"),
        contentType: "application/pdf",
      },
    ]);

    const response = await handler({} as H3Event);

    expect(response.source.content).toBeNull();
  });

  it("decodes a text/markdown blob into content", async () => {
    const source = makeSourceSummary("document");
    vi.stubGlobal("readBody", async () => ({
      userId: "user_source",
      sourceId: source.sourceId,
      includeContent: true,
    }));
    mocks.getSourceSummary.mockResolvedValue(source);
    mocks.fetchRaw.mockResolvedValue([
      {
        kind: "blob",
        sourceId: source.sourceId,
        buffer: Buffer.from("# Notes\nbody", "utf-8"),
        contentType: "text/markdown",
      },
    ]);

    const response = await handler({} as H3Event);

    expect(response.source.content).toEqual({
      text: "# Notes\nbody",
      format: "markdown",
    });
  });
});

function makeSourceSummary(type: SourceSummary["type"]): SourceSummary {
  return {
    sourceId: newTypeId("source"),
    type,
    title: "Source title",
    author: null,
    status: "completed",
    scope: "personal",
    ingestedAt: new Date("2026-06-10T08:00:00.000Z"),
    receivedAt: new Date("2026-06-10T08:01:00.000Z"),
    nodeCount: 2,
  };
}
