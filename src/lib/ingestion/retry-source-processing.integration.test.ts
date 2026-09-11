import { Job, Queue, QueueEvents, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "~/db/schema";
import { sourceIngestionOperations, sources, users } from "~/db/schema";
import {
  completeSourceIngestionOperation,
  createSourceIngestionOperation,
  failSourceIngestionOperation,
  getSourceIngestionOperationById,
  markSourceIngestionProcessing,
} from "~/lib/ingestion/source-processing";
import { setTestDatabase } from "~/utils/db";

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
  let saveMemory: (typeof import("./save-document"))["saveMemory"];
  let ingestDocument: (typeof import("~/lib/jobs/ingest-document"))["ingestDocument"];
  const extractDocumentGraph = vi.fn(async () => undefined);
  const convertToMarkdown = vi.fn(async () => ({
    markdown: "Current request",
    title: null,
  }));
  beforeAll(async () => {
    const admin = new Client({ connectionString: dsn("postgres") });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsn(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    setTestDatabase(database);
    const redisUrl = new URL(
      process.env["REDIS_URL"] ?? "redis://127.0.0.1:56380",
    );
    const connection = { host: redisUrl.hostname, port: Number(redisUrl.port) };
    queue = new Queue(queueName, { connection });
    events = new QueueEvents(queueName, { connection });
    await events.waitUntilReady();
    vi.doMock("~/lib/queues", () => ({ batchQueue: queue }));
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    vi.doMock("~/db", () => ({ default: database }));
    const { SourceService } = await import("~/lib/sources");
    vi.spyOn(MinioClient.prototype, "bucketExists").mockResolvedValue(true);
    const service = new SourceService(
      database,
      new MinioClient({
        endPoint: "localhost",
        port: 9000,
        useSSL: false,
        accessKey: "unused",
        secretKey: "unused",
      }),
      "unused",
    );
    vi.doMock("~/lib/sources", async () => ({
      ...(await vi.importActual<typeof import("~/lib/sources")>(
        "~/lib/sources",
      )),
      sourceService: service,
    }));
    vi.doMock("~/lib/ingestion/extract-document-graph", () => ({
      extractDocumentGraph,
    }));
    vi.doMock("~/lib/converters/markitdown", () => ({ convertToMarkdown }));
    ({ retrySourceProcessing } = await import("./retry-source-processing"));
    ({ saveMemory } = await import("./save-document"));
    ({ ingestDocument } = await import("~/lib/jobs/ingest-document"));
  }, 120_000);
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    vi.clearAllMocks();
  });
  afterAll(async () => {
    setTestDatabase(null);
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

  it.each(["replay", "retry"] as const)(
    "restores one missing document job through concurrent %s calls after queue acceptance fails",
    async (recovery) => {
      const request = {
        userId: `orphan-document-${recovery}`,
        updateExisting: false,
        document: {
          id: "html-message",
          content: "<p>Current request</p>",
          contentType: "html" as const,
          scope: "personal" as const,
          timestamp: new Date("2026-09-10T10:00:00.000Z"),
          author: "Original author",
          title: "Original title",
        },
      };
      const unavailableRedis = vi
        .spyOn(queue, "add")
        .mockRejectedValueOnce(new Error("queue unavailable"));
      try {
        await expect(saveMemory(request)).rejects.toThrow("queue unavailable");
      } finally {
        unavailableRedis.mockRestore();
      }
      const [receipt] = await database
        .select()
        .from(sourceIngestionOperations)
        .where(eq(sourceIngestionOperations.userId, request.userId));
      if (!receipt) throw new Error("Expected durable receipt");
      expect(receipt.status).toBe("queued");
      expect(await queue.getJob(receipt.operationId)).toBeUndefined();
      const recover = async (): Promise<void> => {
        if (recovery === "replay") {
          expect(await saveMemory(request)).toMatchObject({
            sourceId: receipt.sourceId,
            ingestionOperationId: receipt.operationId,
          });
        } else {
          expect(
            await retrySourceProcessing({
              userId: request.userId,
              operationId: receipt.operationId,
            }),
          ).toMatchObject({
            processing: { operationId: receipt.operationId, status: "queued" },
          });
        }
      };
      await Promise.all([recover(), recover()]);
      const job = await queue.getJob(receipt.operationId);
      if (!job) throw new Error("Expected restored job");
      expect(job.name).toBe("ingest-document");
      expect(job.data).toMatchObject({
        operationId: receipt.operationId,
        sourceId: receipt.sourceId,
        contentType: "html",
        documentId: request.document.id,
        timestamp: request.document.timestamp.toISOString(),
        author: "Original author",
        title: "Original title",
      });
      expect(
        (await queue.getWaiting()).filter((waiting) => waiting.id === job.id),
      ).toHaveLength(1);
      expect(
        await database
          .select()
          .from(sources)
          .where(eq(sources.userId, request.userId)),
      ).toHaveLength(1);
      const { IngestDocumentJobInputSchema } = await import(
        "~/lib/jobs/ingest-document"
      );
      worker = new Worker(
        queueName,
        async (queued) => {
          await ingestDocument({
            db: database,
            ...IngestDocumentJobInputSchema.parse(queued.data),
          });
        },
        { connection: queue.opts.connection },
      );
      await job.waitUntilFinished(events, 10_000);
      expect(convertToMarkdown).toHaveBeenCalledExactlyOnceWith({
        buffer: Buffer.from(request.document.content),
        filename: "html-message.html",
        mimeType: "text/html",
      });
      expect(extractDocumentGraph).toHaveBeenCalledOnce();
      expect(
        await getSourceIngestionOperationById({
          db: database,
          userId: request.userId,
          operationId: receipt.operationId,
        }),
      ).toMatchObject({ status: "completed" });
      expect(
        await database
          .select()
          .from(sourceIngestionOperations)
          .where(eq(sourceIngestionOperations.userId, request.userId)),
      ).toHaveLength(1);
    },
  );

  it("restores missing file jobs from their retained conversion settings", async () => {
    const userId = "orphan-file";
    const timestamp = new Date("2026-09-10T11:00:00.000Z");
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "attachment",
        status: "pending",
        lastIngestedAt: timestamp,
        metadata: {
          rawContent: "Attachment text",
          filename: "attachment.txt",
          mimeType: "text/plain",
        },
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const receipt = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "attachment-hash",
    });
    await retrySourceProcessing({ userId, operationId: receipt.operationId });
    const job = await queue.getJob(receipt.operationId);
    if (!job) throw new Error("Expected restored file job");
    expect(job.name).toBe("ingest-file");
    expect(job.data).toMatchObject({
      userId,
      sourceId: source.id,
      operationId: receipt.operationId,
      expectedSourceVersion: receipt.sourceVersion,
      timestamp: timestamp.toISOString(),
      filename: "attachment.txt",
      mimeType: "text/plain",
    });
    const { ingestFile, IngestFileJobInputSchema } = await import(
      "~/lib/jobs/ingest-file"
    );
    worker = new Worker(
      queueName,
      async (queued) => {
        await ingestFile({
          db: database,
          ...IngestFileJobInputSchema.parse(queued.data),
        });
      },
      { connection: queue.opts.connection },
    );
    await job.waitUntilFinished(events, 10_000);
    expect(extractDocumentGraph).toHaveBeenCalledOnce();
    expect(
      await getSourceIngestionOperationById({
        db: database,
        userId,
        operationId: receipt.operationId,
      }),
    ).toMatchObject({ status: "completed" });
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
