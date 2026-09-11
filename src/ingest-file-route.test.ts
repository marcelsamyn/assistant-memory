import handler from "./routes/ingest/file.post";
import { createApp, createError, toWebHandler } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  insertIngestionSource: vi.fn(),
  createSourceIngestionOperation: vi.fn(),
  findSourceIngestionOperation: vi.fn(),
  limit: vi.fn(),
  add: vi.fn(),
}));

vi.mock("~/db", () => ({
  default: {
    select: () => ({
      from: () => ({ where: () => ({ limit: mocks.limit }) }),
    }),
  },
}));
vi.mock("~/lib/sources", () => ({
  sourceService: { insertIngestionSource: mocks.insertIngestionSource },
}));
vi.mock("~/lib/ingestion/source-processing", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/lib/ingestion/source-processing")
  >()),
  createSourceIngestionOperation: mocks.createSourceIngestionOperation,
  findSourceIngestionOperation: mocks.findSourceIngestionOperation,
}));
vi.mock("~/lib/queues", () => ({ batchQueue: { add: mocks.add } }));

function requestFile(): Request {
  const body = new FormData();
  body.set("userId", "user_file");
  body.set("partitionKey", "room:client");
  body.set("externalId", "file-1");
  body.set(
    "file",
    new Blob(["Remember this"], { type: "text/plain" }),
    "notes.txt",
  );
  return new Request("http://memory.test/ingest/file", {
    method: "POST",
    body,
  });
}

describe("POST /ingest/file", () => {
  beforeEach(() => {
    mocks.insertIngestionSource.mockResolvedValue({
      successes: [newTypeId("source")],
      failures: [],
      timestamp: new Date("2026-09-10T09:00:00.000Z"),
      metadata: {},
      revisionHash: "revision-1",
    });
    mocks.limit.mockResolvedValue([{ version: 1 }]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    {
      boundary: "source insertion",
      fail: mocks.insertIngestionSource,
      error: new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "Partition denied",
      ),
    },
    {
      boundary: "processing receipt lookup",
      fail: mocks.findSourceIngestionOperation,
      error: new PartitionAccessError("PARTITION_UNAUTHORIZED", "Source moved"),
    },
    {
      boundary: "processing receipt creation",
      fail: mocks.createSourceIngestionOperation,
      error: new PartitionAccessError(
        "SOURCE_VERSION_CONFLICT",
        "Source changed",
        4,
      ),
    },
  ])("returns structured conflicts from $boundary", async ({ fail, error }) => {
    if (fail === mocks.findSourceIngestionOperation) {
      mocks.insertIngestionSource.mockResolvedValueOnce({
        successes: [],
        failures: [],
        timestamp: new Date("2026-09-10T09:00:00.000Z"),
        metadata: {},
        revisionHash: "revision-1",
      });
      mocks.limit.mockResolvedValueOnce([{ id: newTypeId("source") }]);
    }
    fail.mockRejectedValueOnce(error);

    const response = await toWebHandler(createApp().use(handler))(
      requestFile(),
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
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("preserves unrelated H3 errors", async () => {
    mocks.insertIngestionSource.mockRejectedValueOnce(
      createError({
        statusCode: 403,
        statusMessage: "Source parent denied",
        data: { reason: "parent_partition" },
      }),
    );

    const response = await toWebHandler(createApp().use(handler))(
      requestFile(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      statusMessage: "Source parent denied",
      data: { reason: "parent_partition" },
    });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("preserves multipart validation before source insertion", async () => {
    const body = new FormData();
    body.set("userId", "user_file");
    const response = await toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/ingest/file", { method: "POST", body }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      statusMessage: "missing 'file' part in multipart body",
    });
    expect(mocks.insertIngestionSource).not.toHaveBeenCalled();
  });
});
