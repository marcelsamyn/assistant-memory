import handler from "./routes/sources/processing.post";
import { createApp, readBody, toWebHandler, type H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  getSourceIngestionOperationById: vi.fn(),
  projectInterruptedSourceProcessing: vi.fn(
    (input: { operation: unknown }) => input.operation,
  ),
}));

vi.mock("~/lib/ingestion/source-processing", () => ({
  getSourceIngestionOperationById: mocks.getSourceIngestionOperationById,
  projectInterruptedSourceProcessing: mocks.projectInterruptedSourceProcessing,
  resolveSourceProcessingPartition: vi.fn(),
}));

vi.mock("~/lib/queues", () => ({
  batchQueue: { getJob: vi.fn() },
}));

vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: vi.fn(() => "partition"),
}));

vi.mock("~/utils/db", () => ({
  useDatabase: async (): Promise<unknown> => ({}),
}));

describe("POST /sources/processing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("looks up a retained receipt by user, partition, and operation id", async () => {
    const sourceId = newTypeId("source");
    const receipt = {
      operationId: "operation-1",
      sourceId,
      partitionKey: "opaque:project-1",
      status: "purged",
      stage: "extraction",
      sourceVersion: 4,
      attempt: 1,
      errorCode: "SOURCE_PURGED",
      createdAt: new Date("2026-09-10T08:00:00.000Z"),
      updatedAt: new Date("2026-09-10T09:00:00.000Z"),
      completedAt: new Date("2026-09-10T09:00:00.000Z"),
    };
    vi.stubGlobal("readBody", async () => ({
      userId: "user-1",
      partitionKey: "opaque:project-1",
      operationId: receipt.operationId,
    }));
    mocks.getSourceIngestionOperationById.mockResolvedValue(receipt);

    await expect(handler({} as H3Event)).resolves.toEqual({
      processing: receipt,
    });
    expect(mocks.getSourceIngestionOperationById).toHaveBeenCalledWith({
      db: {},
      userId: "user-1",
      partitionKey: "opaque:project-1",
      operationId: receipt.operationId,
    });
  });

  it("returns a structured conflict for an unauthorized partition", async () => {
    mocks.getSourceIngestionOperationById.mockRejectedValueOnce(
      new PartitionAccessError("PARTITION_UNAUTHORIZED", "Partition denied"),
    );
    vi.stubGlobal("readBody", readBody);

    const response = await toWebHandler(createApp().use(handler))(
      new Request("http://memory.test/sources/processing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId: "user-1",
          partitionKey: "opaque:project-1",
          operationId: "operation-1",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      statusMessage: "Partition denied",
      data: { code: "PARTITION_UNAUTHORIZED" },
    });
  });
});
