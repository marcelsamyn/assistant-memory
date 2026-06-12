import handler from "./routes/rollup.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  add: vi.fn(),
}));

vi.mock("~/lib/queues", () => ({
  batchQueue: { getJob: queueMocks.getJob, add: queueMocks.add },
  ROLLUP_JOB_OPTIONS: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
}));

describe("POST /rollup", () => {
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
});
