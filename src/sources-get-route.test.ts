import handler from "./routes/sources/get.post";
import { createApp, readBody, toWebHandler, type H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import type { SourceSummary } from "~/lib/schemas/sources";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  fetchRaw: vi.fn(),
  getSourceSummary: vi.fn(),
  getSourceIngestionOperation: vi.fn(),
}));

const requestAccessMocks = vi.hoisted(() => ({
  getRequestAccessScope: vi.fn((): "partition" | "workspace" => "partition"),
}));

vi.mock("~/lib/ingestion/source-processing", () => ({
  getSourceIngestionOperation: mocks.getSourceIngestionOperation,
}));

vi.mock("~/lib/sources", () => ({
  sourceService: { fetchRaw: mocks.fetchRaw },
}));

vi.mock("~/lib/sources-read", () => ({
  getSourceSummary: mocks.getSourceSummary,
}));

vi.mock("~/lib/request-access", () => requestAccessMocks);

vi.mock("~/utils/db", () => ({
  useDatabase: async (): Promise<unknown> => ({}),
}));

describe("POST /sources/get", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mocks.getSourceIngestionOperation.mockResolvedValue(null);
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

  it("propagates workspace scope and the source partition to content processing", async () => {
    const source = {
      ...makeSourceSummary("document"),
      partitionKey: contextPartitionKeySchema.parse("workspace:source"),
    };
    requestAccessMocks.getRequestAccessScope.mockReturnValue("workspace");
    mocks.getSourceSummary.mockResolvedValue(source);
    mocks.getSourceIngestionOperation.mockResolvedValue(null);
    mocks.fetchRaw.mockResolvedValue([
      {
        kind: "inline",
        sourceId: source.sourceId,
        content: "workspace content",
      },
    ]);
    vi.stubGlobal("readBody", readBody);

    const response = await toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/sources/get", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memory-access-scope": "workspace",
        },
        body: JSON.stringify({
          userId: "user_source",
          sourceId: source.sourceId,
          includeContent: true,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.getSourceSummary).toHaveBeenCalledWith(
      expect.anything(),
      "user_source",
      source.sourceId,
      undefined,
      "workspace",
    );
    expect(mocks.getSourceIngestionOperation).toHaveBeenCalledWith({
      db: expect.anything(),
      userId: "user_source",
      partitionKey: source.partitionKey,
      sourceId: source.sourceId,
      accessScope: "workspace",
    });
    await expect(response.json()).resolves.toMatchObject({
      source: { content: { text: "workspace content", format: "markdown" } },
    });
  });

  it.each(["getSourceSummary", "getSourceIngestionOperation"] as const)(
    "returns a structured conflict when %s rejects partition access",
    async (operation) => {
      const source = makeSourceSummary("document");
      mocks.getSourceSummary.mockResolvedValue(source);
      mocks[operation].mockRejectedValueOnce(
        new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
      );
      vi.stubGlobal("readBody", readBody);

      const response = await toWebHandler(createApp().use(handler))(
        new Request("http://memory.test/sources/get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: "user_source",
            partitionKey: "opaque:project-1",
            sourceId: source.sourceId,
            includeContent: true,
          }),
        }),
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        statusMessage: "Partition denied",
        data: { code: "PARTITION_UNAUTHORIZED" },
      });
      expect(mocks.fetchRaw).not.toHaveBeenCalled();
    },
  );
});

function makeSourceSummary(type: SourceSummary["type"]): SourceSummary {
  return {
    sourceId: newTypeId("source"),
    partitionKey: null,
    version: 0,
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
