import handler from "./routes/ingest/document.post";
import {
  createApp,
  createError,
  readBody,
  toWebHandler,
  type H3Event,
} from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({ saveMemory: vi.fn() }));
vi.mock("~/lib/ingestion/save-document", () => mocks);

describe("POST /ingest/document", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("forwards the caller-owned partition to document ingestion", async () => {
    const sourceId = newTypeId("source");
    vi.stubGlobal("readBody", async () => ({
      userId: "user_document",
      partitionKey: "room:client",
      document: { id: "document-1", content: "Remember this" },
    }));
    mocks.saveMemory.mockResolvedValue({
      message: "Document ingestion queued",
      jobId: "job-1",
      sourceId,
    });

    await expect(handler({} as H3Event)).resolves.toMatchObject({ sourceId });
    expect(mocks.saveMemory).toHaveBeenCalledWith({
      userId: "user_document",
      partitionKey: "room:client",
      updateExisting: false,
      document: {
        id: "document-1",
        content: "Remember this",
        contentType: "markdown",
        scope: "personal",
      },
    });
  });

  it.each([
    new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    new PartitionAccessError("SOURCE_VERSION_CONFLICT", "Source changed", 4),
  ])("returns the structured $code conflict", async (error) => {
    mocks.saveMemory.mockRejectedValueOnce(error);
    vi.stubGlobal("readBody", readBody);

    const response = await toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/ingest/document", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user_document",
          partitionKey: "room:client",
          document: { id: "document-1", content: "Remember this" },
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ statusMessage: error.message });
    expect(body.data).toEqual({
      code: error.code,
      ...(error.currentSourceVersion === undefined
        ? {}
        : { currentSourceVersion: error.currentSourceVersion }),
    });
  });

  it.each([
    createError({ statusCode: 403, statusMessage: "Source parent denied" }),
    new Error("Queue unavailable"),
  ])("preserves unrelated errors: $message", async (error) => {
    mocks.saveMemory.mockRejectedValueOnce(error);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_document",
      document: { id: "document-1", content: "Remember this" },
    }));

    await expect(handler({} as H3Event)).rejects.toBe(error);
  });
});
