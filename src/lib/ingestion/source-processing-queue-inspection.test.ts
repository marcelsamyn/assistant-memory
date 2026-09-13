import { inspectSourceProcessingJob } from "./source-processing-queue-inspection";
import { Queue } from "bullmq";
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("source processing queue inspection", () => {
  let blackhole: Server;
  let blackholePort: number;
  const sockets = new Set<import("node:net").Socket>();
  let connectionCount = 0;

  beforeAll(async () => {
    blackhole = createServer((socket) => {
      connectionCount += 1;
      sockets.add(socket);
      socket.resume();
      socket.on("end", () => sockets.delete(socket));
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      blackhole.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = blackhole.address();
    if (address === null || typeof address === "string")
      throw new Error("Blackhole server did not expose a port");
    blackholePort = address.port;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      blackhole.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("bounds a non-responding Redis inspection and closes its socket", async () => {
    const startedAt = performance.now();
    await expect(
      inspectSourceProcessingJob("blackhole-operation", {
        redisUrl: `redis://127.0.0.1:${blackholePort}`,
        queueName: "blackhole-processing",
        timeoutMs: 100,
      }),
    ).rejects.toThrow();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    await vi.waitFor(() => expect(sockets.size).toBe(0), { timeout: 1_000 });
    const connectionsAfterReturn = connectionCount;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(connectionCount).toBe(connectionsAfterReturn);
  });

  it("reads a retained job through the disposable queue connection", async () => {
    const redisUrl = new URL(
      process.env["REDIS_URL"] ?? "redis://127.0.0.1:6380",
    );
    const queueName = `inspection-success-${Date.now()}`;
    const queue = new Queue(queueName, {
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port),
      },
      skipMetasUpdate: true,
    });
    const operationId = `inspection-success-${Date.now()}`;
    try {
      const created = await queue.add(
        "ingest-document",
        { operationId, userId: "inspection-user", sourceId: "src_test" },
        { jobId: operationId },
      );
      const inspected = await inspectSourceProcessingJob(operationId, {
        redisUrl: redisUrl.toString(),
        queueName,
      });
      expect(inspected).toMatchObject({
        job: {
          id: created.id,
          name: "ingest-document",
          data: {
            operationId,
            userId: "inspection-user",
            sourceId: "src_test",
          },
        },
        state: "waiting",
      });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
