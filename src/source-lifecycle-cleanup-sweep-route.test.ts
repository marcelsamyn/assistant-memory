import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import route from "~/routes/maintenance/source-lifecycle-cleanup-sweep.post";

const {
  retryPendingSourceTombstoneStorageCleanup,
  deleteRawBlobObjectKeyIfPresent,
  rawBlobObjectKeyExists,
} = vi.hoisted(() => ({
  retryPendingSourceTombstoneStorageCleanup: vi.fn(),
  deleteRawBlobObjectKeyIfPresent: vi.fn(),
  rawBlobObjectKeyExists: vi.fn(),
}));
vi.mock("~/utils/env", () => ({
  env: { PARTITION_MAINTENANCE_TOKEN: "m".repeat(32) },
}));
vi.mock("~/utils/db", () => ({ useDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("~/lib/source-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/source-lifecycle")>()),
  retryPendingSourceTombstoneStorageCleanup,
}));
vi.mock("~/lib/sources", () => ({
  sourceService: { deleteRawBlobObjectKeyIfPresent, rawBlobObjectKeyExists },
}));

function routeFetch(request: Request): Promise<Response> {
  return toWebHandler(createApp().use(route))(request);
}

describe("source lifecycle cleanup sweep maintenance route", () => {
  beforeEach(() => {
    retryPendingSourceTombstoneStorageCleanup.mockReset();
    deleteRawBlobObjectKeyIfPresent.mockReset();
    rawBlobObjectKeyExists.mockReset();
    retryPendingSourceTombstoneStorageCleanup.mockResolvedValue({
      attempted: 2,
      completed: 2,
    });
  });

  it("rejects ordinary bearer credentials before inspecting tombstones", async () => {
    const response = await routeFetch(
      new Request(
        "http://memory.test/maintenance/source-lifecycle-cleanup-sweep",
        {
          method: "POST",
          headers: { authorization: "Bearer no" },
        },
      ),
    );
    expect(response.status).toBe(401);
    expect(retryPendingSourceTombstoneStorageCleanup).not.toHaveBeenCalled();
  });

  it("uses the maintenance credential and applies the bounded request", async () => {
    const response = await routeFetch(
      new Request(
        "http://memory.test/maintenance/source-lifecycle-cleanup-sweep",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${"m".repeat(32)}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ limit: 7 }),
        },
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      attempted: 2,
      completed: 2,
    });
    expect(retryPendingSourceTombstoneStorageCleanup).toHaveBeenCalledWith(
      {},
      expect.any(Function),
      7,
      expect.any(Function),
    );
    const inspect = retryPendingSourceTombstoneStorageCleanup.mock
      .calls[0]?.[3] as ((key: string) => Promise<boolean>) | undefined;
    if (!inspect) throw new Error("Missing object inspection callback");
    rawBlobObjectKeyExists.mockResolvedValueOnce(false);
    await expect(inspect("user/source-key")).resolves.toBe(false);
    expect(rawBlobObjectKeyExists).toHaveBeenCalledWith("user/source-key");
  });
});
