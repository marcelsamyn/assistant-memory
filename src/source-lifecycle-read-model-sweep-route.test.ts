import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import route from "~/routes/maintenance/source-lifecycle-read-model-sweep.post";

const { retryPendingLegacySourceReadModelRetraction } = vi.hoisted(() => ({
  retryPendingLegacySourceReadModelRetraction: vi.fn(),
}));
vi.mock("~/utils/env", () => ({
  env: { PARTITION_MAINTENANCE_TOKEN: "m".repeat(32) },
}));
vi.mock("~/utils/db", () => ({ useDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("~/lib/source-lifecycle", () => ({
  retryPendingLegacySourceReadModelRetraction,
}));

function routeFetch(request: Request): Promise<Response> {
  return toWebHandler(createApp().use(route))(request);
}

describe("source lifecycle read-model sweep maintenance route", () => {
  beforeEach(() => {
    retryPendingLegacySourceReadModelRetraction.mockReset();
    retryPendingLegacySourceReadModelRetraction.mockResolvedValue({
      attempted: 2,
      completed: 2,
    });
  });

  it("rejects ordinary credentials before touching legacy tombstones", async () => {
    const response = await routeFetch(
      new Request(
        "http://memory.test/maintenance/source-lifecycle-read-model-sweep",
        { method: "POST", headers: { authorization: "Bearer no" } },
      ),
    );
    expect(response.status).toBe(401);
    expect(retryPendingLegacySourceReadModelRetraction).not.toHaveBeenCalled();
  });

  it("uses only the maintenance credential and enforces the bounded request", async () => {
    const response = await routeFetch(
      new Request(
        "http://memory.test/maintenance/source-lifecycle-read-model-sweep",
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
    expect(retryPendingLegacySourceReadModelRetraction).toHaveBeenCalledWith(
      {},
      7,
    );
  });
});
