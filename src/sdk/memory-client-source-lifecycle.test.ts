import {
  MemoryClient,
  PartitionMaintenanceUnavailableError,
} from "./memory-client";
import { describe, expect, it, vi } from "vitest";

describe("MemoryClient source lifecycle", () => {
  it("sends source erasure commands only with the maintenance credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sourceId: "src_01jz0000000000000000000000",
        commandId: "00000000-0000-4000-8000-000000000001",
        action: "tombstone",
        state: "tombstoned",
        replayed: false,
        freshIngestionRequired: false,
        storageCleanupState: "not_required",
        sourceVersion: 1,
        restorableUntil: "2026-08-01T00:00:00.000Z",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryClient({
      baseUrl: "http://memory.test",
      apiKey: "ordinary-user-token",
      partitionMaintenanceToken: "maintenance-secret",
    });
    await client.sourceLifecycleCommand({
      userId: "user",
      sourceId: "src_01jz0000000000000000000000",
      expectedPartitionKey: null,
      expectedSourceVersion: 0,
      commandId: "00000000-0000-4000-8000-000000000001",
      action: "tombstone",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/maintenance/source-lifecycle",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          userId: "user",
          sourceId: "src_01jz0000000000000000000000",
          expectedPartitionKey: null,
          expectedSourceVersion: 0,
          commandId: "00000000-0000-4000-8000-000000000001",
          action: "tombstone",
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer maintenance-secret",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("fails locally when no maintenance credential is configured", async () => {
    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    await expect(
      client.sourceLifecycleCommand({
        userId: "user",
        sourceId: "src_01jz0000000000000000000000",
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000001",
        action: "tombstone",
      }),
    ).rejects.toBeInstanceOf(PartitionMaintenanceUnavailableError);
  });

  it("sweeps pending source cleanup only with the maintenance credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ attempted: 3, completed: 3 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryClient({
      baseUrl: "http://memory.test",
      apiKey: "ordinary-user-token",
      partitionMaintenanceToken: "maintenance-secret",
    });
    await client.sweepPendingSourceStorageCleanup({ limit: 3 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/maintenance/source-lifecycle-cleanup-sweep",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ limit: 3 }),
        headers: expect.objectContaining({
          Authorization: "Bearer maintenance-secret",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });

  it("sweeps legacy read-model retraction only with the maintenance credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ attempted: 2, completed: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MemoryClient({
      baseUrl: "http://memory.test",
      apiKey: "ordinary-user-token",
      partitionMaintenanceToken: "maintenance-secret",
    });
    await client.sweepPendingSourceReadModelRetraction({ limit: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/maintenance/source-lifecycle-read-model-sweep",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ limit: 2 }),
        headers: expect.objectContaining({
          Authorization: "Bearer maintenance-secret",
        }),
      }),
    );
    vi.unstubAllGlobals();
  });
});
