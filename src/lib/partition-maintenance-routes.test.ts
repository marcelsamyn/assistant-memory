import { createApp, toWebHandler } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import initializeRoute from "~/routes/maintenance/partition-initialize.post";
import migrationRoute from "~/routes/maintenance/partition-migration.post";

const { initializePartitionedUser, setPartitionMigrationState } = vi.hoisted(
  () => ({
    initializePartitionedUser: vi.fn(),
    setPartitionMigrationState: vi.fn(),
  }),
);
vi.mock("~/utils/env", () => ({
  env: { PARTITION_MAINTENANCE_TOKEN: "m".repeat(32) },
}));
vi.mock("~/utils/db", () => ({ useDatabase: vi.fn().mockResolvedValue({}) }));
vi.mock("~/lib/partition-migration", () => ({
  initializePartitionedUser,
  setPartitionMigrationState,
}));

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

function initializeRouteFetch(request: Request): Promise<Response> {
  const app = createApp().use(initializeRoute);
  return toWebHandler(app)(request);
}

describe("partition maintenance routes", () => {
  beforeEach(() => {
    setPartitionMigrationState.mockReset();
    setPartitionMigrationState.mockResolvedValue({
      state: "migrating",
      version: 1,
    });
    initializePartitionedUser.mockReset();
    initializePartitionedUser.mockResolvedValue({
      state: "migrated",
      version: 1,
      created: true,
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

  it("initializes a new partitioned identity with the dedicated credential", async () => {
    const body = { userId: "new-user", unassignedPartitionKey: "unassigned" };
    const response = await initializeRouteFetch(
      new Request("http://memory.test/maintenance/partition-initialize", {
        method: "POST",
        headers: {
          authorization: `Bearer ${"m".repeat(32)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "migrated",
      version: 1,
      created: true,
    });
    expect(initializePartitionedUser).toHaveBeenCalledWith({}, body);
  });
});
