import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import migrationRoute from "~/routes/maintenance/partition-migration.post";

const { setPartitionMigrationState } = vi.hoisted(() => ({
  setPartitionMigrationState: vi.fn(),
}));
vi.mock("~/utils/env", () => ({
  env: { PARTITION_MAINTENANCE_TOKEN: "m".repeat(32) },
}));
vi.mock("~/utils/db", () => ({ useDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("~/lib/partition-migration", () => ({ setPartitionMigrationState }));

const requestBody = {
  userId: "user",
  expectedState: "unmigrated",
  expectedVersion: 0,
  nextState: "migrating",
};

function routeFetch(request: Request): Promise<Response> {
  const app = createApp().use(migrationRoute);
  return toWebHandler(app)(request);
}

describe("partition maintenance routes", () => {
  beforeEach(() => {
    setPartitionMigrationState.mockReset();
    setPartitionMigrationState.mockResolvedValue({
      state: "migrating",
      version: 1,
    });
  });

  it("rejects an invalid maintenance credential before invoking the service", async () => {
    const response = await routeFetch(
      new Request("http://memory.test/maintenance/partition-migration", {
        method: "POST",
        headers: {
          authorization: "Bearer definitely-wrong",
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }),
    );
    expect(response.status).toBe(401);
    expect(setPartitionMigrationState).not.toHaveBeenCalled();
  });

  it("accepts the dedicated credential and runs the route", async () => {
    const response = await routeFetch(
      new Request("http://memory.test/maintenance/partition-migration", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "migrating",
      version: 1,
    });
    expect(setPartitionMigrationState).toHaveBeenCalledOnce();
  });
});
