import { Job, Queue, QueueEvents, Worker } from "bullmq";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { sources, users } from "~/db/schema";
import {
  completeSourceIngestionOperation,
  createSourceIngestionOperation,
  failSourceIngestionOperation,
  getSourceIngestionOperationById,
  markSourceIngestionProcessing,
} from "~/lib/ingestion/source-processing";

const host = process.env["TEST_PG_HOST"] ?? "localhost";
const port = Number(process.env["TEST_PG_PORT"] ?? 5431);
const databaseUser = process.env["TEST_PG_USER"] ?? "postgres";
const password = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const dsn = (database: string): string =>
  `postgres://${databaseUser}:${password}@${host}:${port}/${database}`;
async function isPostgresReachable(): Promise<boolean> {
  const client = new Client({ connectionString: dsn("postgres") });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}
const describeIfPostgres = (await isPostgresReachable())
  ? describe
  : describe.skip;

describeIfPostgres("retained processing retry", () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `memory_retry_${suffix}`;
  const queueName = `memory-review-retry-${suffix}`;
  let client: Client;
  let database: NodePgDatabase<typeof schema>;
  let queue: Queue;
  let events: QueueEvents;
  let worker: Worker | undefined;
  let retrySourceProcessing: (typeof import("./retry-source-processing"))["retrySourceProcessing"];
  beforeAll(async () => {
    const admin = new Client({ connectionString: dsn("postgres") });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsn(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    const redisUrl = new URL(
      process.env["REDIS_URL"] ?? "redis://127.0.0.1:56380",
    );
    const connection = { host: redisUrl.hostname, port: Number(redisUrl.port) };
    queue = new Queue(queueName, { connection });
    events = new QueueEvents(queueName, { connection });
    await events.waitUntilReady();
    vi.doMock("~/lib/queues", () => ({ batchQueue: queue }));
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    ({ retrySourceProcessing } = await import("./retry-source-processing"));
  }, 120_000);
  afterAll(async () => {
    await worker?.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await client.end();
    const admin = new Client({ connectionString: dsn("postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("retries a completed unreadable job and recovers a queue retry failure without relaxing ownership", async () => {
    const userId = "retry-owner";
    await database.insert(users).values([{ id: userId }, { id: "other-user" }]);
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "file",
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const accepted = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "file-hash",
    });
    const input = {
      db: database,
      userId,
      sourceId: source.id,
      operationId: accepted.operationId,
    };
    let runs = 0;
    worker = new Worker(
      queueName,
      async () => {
        runs += 1;
        const processing = await markSourceIngestionProcessing(input);
        if (runs === 1)
          await failSourceIngestionOperation({
            ...input,
            expectedSourceVersion: processing.sourceVersion,
            errorCode: "UNREADABLE_CONTENT",
            stage: "content",
          });
        else
          await completeSourceIngestionOperation({
            ...input,
            expectedSourceVersion: processing.sourceVersion,
          });
      },
      { connection: queue.opts.connection },
    );
    const job = await queue.add(
      "ingest-file",
      {},
      { jobId: accepted.operationId },
    );
    await job.waitUntilFinished(events, 10_000);
    expect(await job.getState()).toBe("completed");
    expect(await getSourceIngestionOperationById(input)).toMatchObject({
      status: "failed",
      errorCode: "UNREADABLE_CONTENT",
    });
    await expect(
      retrySourceProcessing({
        userId: "other-user",
        operationId: accepted.operationId,
      }),
    ).rejects.toMatchObject({ code: "PARTITION_UNAUTHORIZED" });
    expect(await job.getState()).toBe("completed");
    const unavailableRedis = vi
      .spyOn(Job.prototype, "retry")
      .mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      await expect(
        retrySourceProcessing({ userId, operationId: accepted.operationId }),
      ).rejects.toThrow("queue unavailable");
    } finally {
      unavailableRedis.mockRestore();
    }
    expect(await getSourceIngestionOperationById(input)).toMatchObject({
      status: "queued",
    });
    expect(await job.getState()).toBe("completed");
    await retrySourceProcessing({ userId, operationId: accepted.operationId });
    await job.waitUntilFinished(events, 10_000);
    expect(await getSourceIngestionOperationById(input)).toMatchObject({
      status: "completed",
    });
    expect(runs).toBe(2);
    await expect(
      retrySourceProcessing({ userId, operationId: accepted.operationId }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(runs).toBe(2);
  });

  it("does not reopen a failed receipt while its retained job is active", async () => {
    const userId = "retry-active-owner";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "active-file",
        status: "failed",
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const accepted = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "active-file-hash",
    });
    const input = {
      db: database,
      userId,
      sourceId: source.id,
      operationId: accepted.operationId,
    };
    const processing = await markSourceIngestionProcessing(input);
    await failSourceIngestionOperation({
      ...input,
      expectedSourceVersion: processing.sourceVersion,
      errorCode: "UNREADABLE_CONTENT",
      stage: "content",
    });
    const job = await queue.add(
      "ingest-file",
      {},
      { jobId: accepted.operationId },
    );
    const activeWorker = new Worker(
      queueName,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      },
      { connection: queue.opts.connection },
    );
    try {
      await vi.waitFor(
        async () => expect(await job.getState()).toBe("active"),
        { timeout: 5_000 },
      );
      await expect(
        retrySourceProcessing({ userId, operationId: accepted.operationId }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await getSourceIngestionOperationById(input)).toMatchObject({
        status: "failed",
      });
    } finally {
      await activeWorker.close();
    }
  });
});
