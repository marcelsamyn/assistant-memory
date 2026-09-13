import handler from "./routes/rollup.post";
import type { H3Event } from "h3";
import IORedis from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  add: vi.fn(),
  toKey: vi.fn(),
}));

const redisMocks = vi.hoisted(() => ({
  incr: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  getRequestAccessScope: vi.fn(() => "partition"),
  assertWorkspaceOperationReady: vi.fn(),
  resolveWorkspacePartitions: vi.fn(async (_db, _userId, partitionKey) => [
    partitionKey,
  ]),
}));

vi.mock("~/lib/queues", () => ({
  batchQueue: {
    getJob: queueMocks.getJob,
    add: queueMocks.add,
    toKey: queueMocks.toKey,
  },
  redisConnection: redisMocks,
  ROLLUP_JOB_OPTIONS: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
}));

vi.mock("~/lib/request-access", () => ({
  getRequestAccessScope: workspaceMocks.getRequestAccessScope,
}));

vi.mock("~/lib/workspace-partitions", () => ({
  assertWorkspaceOperationReady: workspaceMocks.assertWorkspaceOperationReady,
  resolveWorkspacePartitions: workspaceMocks.resolveWorkspacePartitions,
}));

vi.mock("~/utils/db", () => ({
  useDatabase: vi.fn().mockResolvedValue({}),
}));

describe("POST /rollup", () => {
  beforeEach(() => {
    queueMocks.toKey.mockImplementation((name: string) => `bull:test:${name}`);
    redisMocks.incr.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("applies defaults and enqueues with a deterministic jobId", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "user_r" }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});

    const response = await handler({} as H3Event);

    expect(queueMocks.add).toHaveBeenCalledWith(
      "rollup",
      { userId: "user_r", maxLlmCalls: 50 },
      expect.objectContaining({ jobId: "rollup:user_r", attempts: 3 }),
    );
    expect(response).toMatchObject({ enqueued: true });
  });

  it("passes startDate and maxLlmCalls through", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_r",
      maxLlmCalls: 10,
      startDate: "2026-01-01",
    }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});

    await handler({} as H3Event);

    expect(queueMocks.add).toHaveBeenCalledWith(
      "rollup",
      { userId: "user_r", maxLlmCalls: 10, startDate: "2026-01-01" },
      expect.objectContaining({ jobId: "rollup:user_r" }),
    );
  });

  it("does not double-enqueue while a sweep is queued or running", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "user_r" }));
    queueMocks.getJob.mockResolvedValue({
      getState: async () => "waiting",
      remove: vi.fn(),
    });

    const response = await handler({} as H3Event);

    expect(queueMocks.add).not.toHaveBeenCalled();
    expect(response).toMatchObject({ enqueued: false });
  });

  it("removes a finished job with the same id, then re-enqueues", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "user_r" }));
    const remove = vi.fn();
    queueMocks.getJob.mockResolvedValue({
      getState: async () => "failed",
      remove,
    });
    queueMocks.add.mockResolvedValue({});

    const response = await handler({} as H3Event);

    expect(remove).toHaveBeenCalled();
    expect(queueMocks.add).toHaveBeenCalled();
    expect(response).toMatchObject({ enqueued: true });
  });

  it("rejects a malformed startDate before enqueueing", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_r",
      startDate: "Jan 1",
    }));

    await expect(handler({} as H3Event)).rejects.toThrow();
    expect(queueMocks.add).not.toHaveBeenCalled();
  });

  it("splits a workspace budget across strict partition jobs", async () => {
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
      "workspace:two",
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_r",
      maxLlmCalls: 5,
    }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});

    const response = await handler({} as H3Event);

    expect(queueMocks.add).toHaveBeenCalledTimes(2);
    expect(queueMocks.add).toHaveBeenNthCalledWith(
      1,
      "rollup",
      { userId: "user_r", maxLlmCalls: 3, partitionKey: "workspace:one" },
      expect.objectContaining({ jobId: "rollup:user_r:workspace:one" }),
    );
    expect(queueMocks.add).toHaveBeenNthCalledWith(
      2,
      "rollup",
      { userId: "user_r", maxLlmCalls: 2, partitionKey: "workspace:two" },
      expect.objectContaining({ jobId: "rollup:user_r:workspace:two" }),
    );
    expect(response).toMatchObject({ enqueued: true });
  });

  it("rotates a small workspace budget across partitions", async () => {
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
      "workspace:two",
      "workspace:three",
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_fair",
      maxLlmCalls: 1,
    }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});
    redisMocks.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);

    for (let index = 0; index < 3; index += 1) {
      queueMocks.add.mockClear();
      await handler({} as H3Event);
      expect(queueMocks.add).toHaveBeenCalledTimes(1);
      expect(queueMocks.add.mock.calls[0]?.[1]).toMatchObject({
        maxLlmCalls: 1,
        partitionKey: `workspace:${["one", "two", "three"][index]}`,
      });
    }
    expect(redisMocks.incr).toHaveBeenCalledTimes(3);
    expect(redisMocks.incr).toHaveBeenCalledWith(
      "bull:test:rollup-fair-cursor:user_fair",
    );
  });

  it("does not advance the workspace cursor for one partition or strict access", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_single",
      maxLlmCalls: 1,
    }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
    ]);
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    await handler({} as H3Event);
    workspaceMocks.getRequestAccessScope.mockReturnValue("partition");
    await handler({} as H3Event);
    expect(redisMocks.incr).not.toHaveBeenCalled();
  });

  it("keeps later partitions moving when the rotated partition is busy", async () => {
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
      "workspace:two",
      "workspace:three",
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_busy",
      maxLlmCalls: 1,
    }));
    redisMocks.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    queueMocks.getJob.mockResolvedValue({
      getState: async () => "waiting",
      remove: vi.fn(),
    });
    await handler({} as H3Event);
    expect(queueMocks.add).not.toHaveBeenCalled();

    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});
    await handler({} as H3Event);
    expect(queueMocks.add).toHaveBeenCalledWith(
      "rollup",
      expect.objectContaining({
        partitionKey: "workspace:two",
        maxLlmCalls: 1,
      }),
      expect.anything(),
    );
  });

  it("uses distinct cursor values for concurrent workspace requests", async () => {
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
      "workspace:two",
      "workspace:three",
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_concurrent_fair",
      maxLlmCalls: 1,
    }));
    let nextCursor = 0;
    redisMocks.incr.mockImplementation(async () => {
      nextCursor += 1;
      return nextCursor;
    });
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});

    await Promise.all([handler({} as H3Event), handler({} as H3Event)]);

    expect(queueMocks.add).toHaveBeenCalledTimes(2);
    expect(queueMocks.add.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ partitionKey: "workspace:one" }),
        expect.objectContaining({ partitionKey: "workspace:two" }),
      ]),
    );
  });

  it("advances fairness after an enqueue failure", async () => {
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
      "workspace:two",
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_enqueue_failure",
      maxLlmCalls: 1,
    }));
    queueMocks.getJob.mockResolvedValue(undefined);
    redisMocks.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    queueMocks.add.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(handler({} as H3Event)).rejects.toThrow("queue unavailable");

    queueMocks.add.mockResolvedValue({});
    await handler({} as H3Event);
    expect(queueMocks.add).toHaveBeenLastCalledWith(
      "rollup",
      expect.objectContaining({
        partitionKey: "workspace:two",
        maxLlmCalls: 1,
      }),
      expect.anything(),
    );
  });

  it("fails closed when the workspace fairness cursor is unavailable", async () => {
    workspaceMocks.getRequestAccessScope.mockReturnValue("workspace");
    workspaceMocks.resolveWorkspacePartitions.mockResolvedValue([
      "workspace:one",
      "workspace:two",
    ]);
    vi.stubGlobal("readBody", async () => ({
      userId: "user_cursor_failure",
      maxLlmCalls: 1,
    }));
    redisMocks.incr.mockRejectedValue(new Error("redis unavailable"));

    await expect(handler({} as H3Event)).rejects.toThrow("redis unavailable");
    expect(queueMocks.getJob).not.toHaveBeenCalled();
    expect(queueMocks.add).not.toHaveBeenCalled();
  });

  it("uses a persistent queue-namespaced Redis cursor with atomic increments", async () => {
    const redis = new IORedis(
      process.env["REDIS_URL"] ?? "redis://localhost:6380",
    );
    const { Queue } = await import("bullmq");
    const queue = new Queue("batchProcessing", { connection: redis });
    const cursorKey = queue.toKey(`rollup-fair-cursor:test:${Date.now()}`);

    try {
      await redis.del(cursorKey);
      const values = await Promise.all(
        Array.from({ length: 4 }, () => redis.incr(cursorKey)),
      );
      expect([...values].sort((left, right) => left - right)).toEqual([
        1, 2, 3, 4,
      ]);

      const reader = new IORedis(
        process.env["REDIS_URL"] ?? "redis://localhost:6380",
      );
      try {
        await expect(reader.get(cursorKey)).resolves.toBe("4");
      } finally {
        await reader.del(cursorKey);
        await reader.quit();
      }
    } finally {
      await queue.close();
      await redis.quit();
    }
  });
});
