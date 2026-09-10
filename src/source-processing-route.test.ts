import handler from "./routes/sources/processing.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({
  getSourceIngestionOperationById: vi.fn(),
}));

vi.mock("~/lib/ingestion/source-processing", () => ({
  getSourceIngestionOperationById: mocks.getSourceIngestionOperationById,
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
});
