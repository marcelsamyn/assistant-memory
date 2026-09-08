import handler from "./routes/ingest/document.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
