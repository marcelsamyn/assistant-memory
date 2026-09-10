import { contextPartitionKeySchema } from "../lib/schemas/partition";
import {
  MemoryClient,
  PartitionConflictError,
  PartitionMaintenanceUnavailableError,
} from "./memory-client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MemoryClient partition migration", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends authenticated CAS and idempotent reclassification requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ state: "migrating", version: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          sourceId: "src_01jz0000000000000000000000",
          partitionKey: "opaque:a",
          sourceVersion: 1,
          bindingGeneration: "generation-1",
          replayed: false,
          movedClaimCount: 0,
          nodeMappings: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new MemoryClient({
      baseUrl: "http://memory.test",
      apiKey: "secret",
      partitionMaintenanceToken: "maintenance-secret",
    });
    await client.setPartitionMigrationState({
      userId: "user",
      expectedState: "unmigrated",
      expectedVersion: 0,
      nextState: "migrating",
    });
    await client.reclassifySourcePartition({
      userId: "user",
      sourceId: "src_01jz0000000000000000000000",
      expectedPartitionKey: null,
      targetPartitionKey: contextPartitionKeySchema.parse("opaque:a"),
      expectedSourceVersion: 0,
      bindingGeneration: "generation-1",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://memory.test/maintenance/partition-migration",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          userId: "user",
          expectedState: "unmigrated",
          expectedVersion: 0,
          nextState: "migrating",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer maintenance-secret",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://memory.test/maintenance/partition-reclassify",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          userId: "user",
          sourceId: "src_01jz0000000000000000000000",
          expectedPartitionKey: null,
          targetPartitionKey: "opaque:a",
          expectedSourceVersion: 0,
          bindingGeneration: "generation-1",
        }),
      }),
    );
  });

  it("fails locally when no maintenance credential is configured", async () => {
    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    await expect(
      client.getPartitionProgress({ userId: "user" }),
    ).rejects.toBeInstanceOf(PartitionMaintenanceUnavailableError);
  });

  it("reads authenticated progress and paginated inventory", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          migration: { state: "migrating", version: 2 },
          source: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [], nextCursor: null }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryClient({
      baseUrl: "http://memory.test",
      partitionMaintenanceToken: "maintenance-secret",
    });
    await client.getPartitionProgress({ userId: "user" });
    await client.getPartitionInventory({ userId: "user" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://memory.test/maintenance/partition-progress",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer maintenance-secret",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://memory.test/maintenance/partition-inventory",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ userId: "user" }),
      }),
    );
  });

  it("surfaces structured authoritative conflict state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        statusText: "Conflict",
        json: async () => ({
          statusMessage: "Source changed",
          data: {
            code: "SOURCE_VERSION_CONFLICT",
            current: { sourceVersion: 4, sourcePartitionKey: "opaque:b" },
          },
        }),
      }),
    );
    const client = new MemoryClient({
      baseUrl: "http://memory.test",
      partitionMaintenanceToken: "maintenance-secret",
    });
    const error = await client
      .reclassifySourcePartition({
        userId: "user",
        sourceId: "src_01jz0000000000000000000000",
        expectedPartitionKey: null,
        targetPartitionKey: contextPartitionKeySchema.parse("opaque:a"),
        expectedSourceVersion: 0,
        bindingGeneration: "generation-1",
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PartitionConflictError);
    expect(error).toMatchObject({
      code: "SOURCE_VERSION_CONFLICT",
      current: { sourceVersion: 4, sourcePartitionKey: "opaque:b" },
    });
  });

  it("looks up ingestion processing by its stable operation id", async () => {
    const processing = {
      operationId: "operation-1",
      sourceId: "src_01jz0000000000000000000000",
      partitionKey: null,
      status: "purged",
      stage: "extraction",
      sourceVersion: 4,
      attempt: 1,
      errorCode: "SOURCE_PURGED",
      createdAt: "2026-09-10T08:00:00.000Z",
      updatedAt: "2026-09-10T09:00:00.000Z",
      completedAt: "2026-09-10T09:00:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ processing }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryClient({ baseUrl: "http://memory.test" });

    await expect(
      client.getSourceProcessing({
        userId: "user",
        operationId: processing.operationId,
      }),
    ).resolves.toMatchObject({
      processing: {
        operationId: processing.operationId,
        status: "purged",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/sources/processing",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          userId: "user",
          operationId: processing.operationId,
        }),
      }),
    );
  });
});
