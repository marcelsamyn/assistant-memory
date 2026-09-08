import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import route from "~/routes/maintenance/source-lifecycle.post";

const {
  applySourceLifecycleCommand,
  listSourceLifecycleStorageCleanupKeys,
  markSourceTreeStorageCleanupCompleted,
  deleteRawBlobObjectKeyIfPresent,
} = vi.hoisted(() => ({
  applySourceLifecycleCommand: vi.fn(),
  listSourceLifecycleStorageCleanupKeys: vi.fn(),
  markSourceTreeStorageCleanupCompleted: vi.fn(),
  deleteRawBlobObjectKeyIfPresent: vi.fn(),
}));
vi.mock("~/utils/env", () => ({
  env: { PARTITION_MAINTENANCE_TOKEN: "m".repeat(32) },
}));
vi.mock("~/utils/db", () => ({ useDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("~/lib/source-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/source-lifecycle")>()),
  applySourceLifecycleCommand,
  listSourceLifecycleStorageCleanupKeys,
  markSourceTreeStorageCleanupCompleted,
}));
vi.mock("~/lib/sources", () => ({
  sourceService: { deleteRawBlobObjectKeyIfPresent },
}));

const body = {
  userId: "user",
  sourceId: "src_01jz0000000000000000000000",
  expectedPartitionKey: null,
  expectedSourceVersion: 3,
  commandId: "00000000-0000-4000-8000-000000000001",
  action: "tombstone",
};

function routeFetch(request: Request): Promise<Response> {
  return toWebHandler(createApp().use(route))(request);
}

describe("source lifecycle maintenance route", () => {
  beforeEach(() => {
    applySourceLifecycleCommand.mockReset();
    listSourceLifecycleStorageCleanupKeys.mockReset();
    markSourceTreeStorageCleanupCompleted.mockReset();
    deleteRawBlobObjectKeyIfPresent.mockReset();
    listSourceLifecycleStorageCleanupKeys.mockResolvedValue([
      "user/source-key",
    ]);
    applySourceLifecycleCommand.mockResolvedValue({
      sourceId: body.sourceId,
      commandId: body.commandId,
      action: body.action,
      state: "tombstoned",
      replayed: false,
      freshIngestionRequired: false,
      storageCleanupState: "not_required",
      sourceVersion: 4,
      restorableUntil: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("rejects ordinary bearer credentials before touching the lifecycle service", async () => {
    const response = await routeFetch(
      new Request("http://memory.test/maintenance/source-lifecycle", {
        method: "POST",
        headers: {
          authorization: "Bearer no",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(401);
    expect(applySourceLifecycleCommand).not.toHaveBeenCalled();
  });

  it("uses only the maintenance token and returns the typed non-content receipt", async () => {
    const response = await routeFetch(
      new Request("http://memory.test/maintenance/source-lifecycle", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "tombstoned",
      sourceVersion: 4,
      freshIngestionRequired: false,
    });
    expect(applySourceLifecycleCommand).toHaveBeenCalledOnce();
  });

  it.each(["completed", "pending"] as const)(
    "returns the durable cleanup outcome after deletion: %s",
    async (storageCleanupState) => {
      applySourceLifecycleCommand.mockResolvedValueOnce({
        sourceId: body.sourceId,
        commandId: body.commandId,
        action: body.action,
        state: "tombstoned",
        replayed: false,
        freshIngestionRequired: false,
        storageCleanupState: "pending",
        sourceVersion: 4,
        restorableUntil: new Date("2026-08-01T00:00:00.000Z"),
      });
      applySourceLifecycleCommand.mockResolvedValueOnce({
        sourceId: body.sourceId,
        commandId: body.commandId,
        action: body.action,
        state: "tombstoned",
        replayed: true,
        freshIngestionRequired: false,
        storageCleanupState,
        sourceVersion: 4,
        restorableUntil: new Date("2026-08-01T00:00:00.000Z"),
      });
      const response = await routeFetch(
        new Request("http://memory.test/maintenance/source-lifecycle", {
          method: "POST",
          headers: {
            authorization: `Bearer ${"m".repeat(32)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
      await expect(response.json()).resolves.toMatchObject({
        storageCleanupState,
        replayed: false,
      });
      expect(deleteRawBlobObjectKeyIfPresent).toHaveBeenCalledWith(
        "user/source-key",
      );
      expect(markSourceTreeStorageCleanupCompleted).toHaveBeenCalledOnce();
    },
  );

  it("keeps the durable cleanup receipt pending when object deletion fails for a retry", async () => {
    applySourceLifecycleCommand.mockResolvedValueOnce({
      sourceId: body.sourceId,
      commandId: body.commandId,
      action: body.action,
      state: "tombstoned",
      replayed: true,
      freshIngestionRequired: false,
      storageCleanupState: "pending",
      sourceVersion: 4,
      restorableUntil: new Date("2026-08-01T00:00:00.000Z"),
    });
    deleteRawBlobObjectKeyIfPresent.mockRejectedValueOnce(
      new Error("object store is briefly grumpy"),
    );
    const response = await routeFetch(
      new Request("http://memory.test/maintenance/source-lifecycle", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(500);
    expect(markSourceTreeStorageCleanupCompleted).not.toHaveBeenCalled();
  });

  it("cleans every blob in the tombstoned source tree before acknowledging it", async () => {
    const childObjectKey = "user/src_01jz0000000000000000000001";
    applySourceLifecycleCommand.mockResolvedValueOnce({
      sourceId: body.sourceId,
      commandId: body.commandId,
      action: body.action,
      state: "tombstoned",
      replayed: false,
      freshIngestionRequired: false,
      storageCleanupState: "pending",
      sourceVersion: 4,
      restorableUntil: new Date("2026-08-01T00:00:00.000Z"),
    });
    listSourceLifecycleStorageCleanupKeys.mockResolvedValueOnce([
      "user/src_01jz0000000000000000000000",
      childObjectKey,
    ]);
    const response = await routeFetch(
      new Request("http://memory.test/maintenance/source-lifecycle", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    expect(deleteRawBlobObjectKeyIfPresent).toHaveBeenCalledTimes(2);
    expect(deleteRawBlobObjectKeyIfPresent).toHaveBeenCalledWith(
      childObjectKey,
    );
    expect(markSourceTreeStorageCleanupCompleted).toHaveBeenCalledWith(
      {},
      "user",
      body.sourceId,
    );
  });
});
