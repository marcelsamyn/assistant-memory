import handler from "./routes/transcript/ingest.post";
import { createApp, createError, toWebHandler } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";

const mocks = vi.hoisted(() => ({
  preparePartitionWrite: vi.fn(),
  ensureUser: vi.fn(),
  add: vi.fn(),
}));

vi.mock("~/db", () => ({ default: {} }));
vi.mock("~/lib/ingestion/ensure-user", () => ({
  ensureUser: mocks.ensureUser,
}));
vi.mock("~/lib/partition-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/partition-access")>()),
  preparePartitionWrite: mocks.preparePartitionWrite,
}));
vi.mock("~/lib/queues", () => ({ batchQueue: { add: mocks.add } }));

function requestTranscript(): Request {
  return new Request("http://memory.test/transcript/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: "user_transcript",
      partitionKey: "room:client",
      transcriptId: "transcript-1",
      occurredAt: "2026-09-10T09:00:00.000Z",
      content: { kind: "raw", text: "Remember this" },
    }),
  });
}

describe("POST /transcript/ingest", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    new PartitionAccessError(
      "PARTITION_MIGRATION_REQUIRED",
      "Migration required",
    ),
  ])("returns the structured $code conflict", async (error) => {
    mocks.preparePartitionWrite.mockRejectedValueOnce(error);

    const response = await toWebHandler(createApp().use(handler))(
      requestTranscript(),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ statusMessage: error.message });
    expect(body.data).toEqual({ code: error.code });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it.each([403, 409])(
    "preserves unrelated %i H3 errors",
    async (statusCode) => {
      mocks.preparePartitionWrite.mockRejectedValueOnce(
        createError({
          statusCode,
          statusMessage: "Transcript source unavailable",
          data: { reason: "source_conflict" },
        }),
      );

      const response = await toWebHandler(createApp().use(handler))(
        requestTranscript(),
      );

      expect(response.status).toBe(statusCode);
      await expect(response.json()).resolves.toMatchObject({
        statusMessage: "Transcript source unavailable",
        data: { reason: "source_conflict" },
      });
      expect(mocks.add).not.toHaveBeenCalled();
    },
  );
});
