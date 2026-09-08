import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import route from "~/routes/maintenance/source-lifecycle-cleanup-sweep.post";

const {
  retryPendingSourceTombstoneStorageCleanup,
  deleteRawBlobObjectKeyIfPresent,
} = vi.hoisted(() => ({
  retryPendingSourceTombstoneStorageCleanup: vi.fn(),
  deleteRawBlobObjectKeyIfPresent: vi.fn(),
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
  sourceService: { deleteRawBlobObjectKeyIfPresent },
}));

function routeFetch(request: Request): Promise<Response> {
  return toWebHandler(createApp().use(route))(request);
}

describe("source lifecycle cleanup sweep maintenance route", () => {
  beforeEach(() => {
    retryPendingSourceTombstoneStorageCleanup.mockReset();
    deleteRawBlobObjectKeyIfPresent.mockReset();
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
    );
  });
});
