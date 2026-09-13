import { Job, Queue, QueueEvents, Worker } from "bullmq";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp, readBody, toWebHandler } from "h3";
import { Client as MinioClient } from "minio";
import { randomUUID } from "node:crypto";
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
import {
  memoryPartitions,
  partitionMigrationState,
  sourceIngestionOperations,
  sources,
  users,
} from "~/db/schema";
import {
  completeSourceIngestionOperation,
  createSourceIngestionOperation,
  failSourceIngestionOperation,
  getSourceIngestionOperationById,
  markSourceIngestionProcessing,
  markSourceIngestionExtractionStarted,
  projectInterruptedSourceProcessing,
} from "~/lib/ingestion/source-processing";
import * as sourceProcessingModule from "~/lib/ingestion/source-processing";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { sourceLifecycleCommandRequestSchema } from "~/lib/schemas/source-lifecycle";
import { applySourceLifecycleCommand } from "~/lib/source-lifecycle";
import { newTypeId } from "~/types/typeid";
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
    vi.resetModules();
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const moduleId of [
      "~/db",
      "~/lib/queues",
      "~/lib/sources",
      "~/lib/ingestion/extract-document-graph",
      "~/lib/converters/markitdown",
    ])
      vi.doUnmock(moduleId);
    vi.resetModules();
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

  it("projects a terminal retained job without mutating its receipt and retries it", async () => {
    const userId = "stalled-receipt-owner";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "stalled-document",
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const receipt = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "stalled-document-hash",
    });
    const input = {
      db: database,
      userId,
      sourceId: source.id,
      operationId: receipt.operationId,
    };
    const processing = await markSourceIngestionProcessing(input);
    const extraction = await markSourceIngestionExtractionStarted(input);
    const [before] = await database
      .select()
      .from(sourceIngestionOperations)
      .where(eq(sourceIngestionOperations.operationId, receipt.operationId));
    if (!before) throw new Error("Receipt missing");

    worker = new Worker(
      queueName,
      async (): Promise<void> => {
        throw new Error("simulated stalled job terminal failure");
      },
      { connection: queue.opts.connection },
    );
    const job = await queue.add(
      "ingest-document",
      {
        userId,
        sourceId: source.id,
        operationId: receipt.operationId,
      },
      { jobId: receipt.operationId, attempts: 1 },
    );
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "simulated stalled job terminal failure",
    );
    expect(await job.getState()).toBe("failed");
    await worker.close();
    worker = undefined;

    const projected = await projectInterruptedSourceProcessing({
      db: database,
      userId,
      operation: extraction,
      queue,
    });
    expect(projected).toMatchObject({
      operationId: receipt.operationId,
      sourceId: source.id,
      status: "failed",
      stage: "extraction",
      sourceVersion: processing.sourceVersion,
      attempt: processing.attempt,
      errorCode: "PROCESSING_INTERRUPTED",
      completedAt: null,
    });
    const [after] = await database
      .select()
      .from(sourceIngestionOperations)
      .where(eq(sourceIngestionOperations.operationId, receipt.operationId));
    expect(after).toEqual(before);

    vi.stubGlobal("readBody", readBody);
    vi.doMock("~/lib/ingestion/source-processing", () => ({
      ...sourceProcessingModule,
      projectInterruptedSourceProcessing: (
        projectorInput: Parameters<
          typeof projectInterruptedSourceProcessing
        >[0],
      ) => projectInterruptedSourceProcessing({ ...projectorInput, queue }),
    }));
    const { default: processingRoute } = await import(
      "~/routes/sources/processing.post"
    );
    const statusResponse = await toWebHandler(createApp().use(processingRoute))(
      new Request("http://memory.test/sources/processing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, operationId: receipt.operationId }),
      }),
    );
    vi.doUnmock("~/lib/ingestion/source-processing");
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toMatchObject({
      processing: {
        operationId: receipt.operationId,
        status: "failed",
        errorCode: "PROCESSING_INTERRUPTED",
      },
    });

    await expect(
      retrySourceProcessing({ userId, operationId: receipt.operationId }),
    ).resolves.toMatchObject({
      processing: {
        operationId: receipt.operationId,
        status: "processing",
        stage: "extraction",
      },
    });
    expect(await job.getState()).toBe("waiting");

    worker = new Worker(
      queueName,
      async () => {
        const current = await getSourceIngestionOperationById({
          db: database,
          userId,
          operationId: receipt.operationId,
        });
        if (!current) throw new Error("Receipt missing during retry");
        await completeSourceIngestionOperation({
          ...input,
          expectedSourceVersion: current.sourceVersion,
        });
      },
      { connection: queue.opts.connection },
    );
    await job.waitUntilFinished(events, 10_000);
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
      {
        userId,
        sourceId: accepted.sourceId,
        operationId: accepted.operationId,
      },
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

  it("returns the changed receipt when it changes during queue observation", async () => {
    const userId = "stalled-receipt-changed";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "changed-document",
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const receipt = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "changed-document-hash",
    });
    const input = {
      db: database,
      userId,
      sourceId: source.id,
      operationId: receipt.operationId,
    };
    const processing = await markSourceIngestionProcessing(input);
    let stateReads = 0;
    const getState = vi.fn(async () => {
      stateReads += 1;
      if (stateReads === 1) {
        await completeSourceIngestionOperation({
          ...input,
          expectedSourceVersion: processing.sourceVersion,
        });
      }
      return "failed";
    });
    const job = {
      id: receipt.operationId,
      name: "ingest-document",
      data: { userId, sourceId: source.id, operationId: receipt.operationId },
      getState,
    };

    const changed = await projectInterruptedSourceProcessing({
      db: database,
      userId,
      operation: processing,
      queue: { getJob: async () => job },
    });
    expect(changed).toMatchObject({
      operationId: receipt.operationId,
      status: "completed",
    });
    expect(job.getState).toHaveBeenCalledOnce();
  });

  it("propagates queue state errors without changing the receipt", async () => {
    const userId = "stalled-receipt-state-error";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "state-error-document",
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const receipt = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "state-error-document-hash",
    });
    const processing = await markSourceIngestionProcessing({
      db: database,
      userId,
      sourceId: source.id,
      operationId: receipt.operationId,
    });
    const [before] = await database
      .select()
      .from(sourceIngestionOperations)
      .where(eq(sourceIngestionOperations.operationId, receipt.operationId));
    if (!before) throw new Error("Receipt missing");
    const queueError = new Error("Redis state inspection failed");
    const getState = vi.fn().mockRejectedValue(queueError);

    await expect(
      projectInterruptedSourceProcessing({
        db: database,
        userId,
        operation: processing,
        queue: {
          getJob: async () => ({
            id: receipt.operationId,
            name: "ingest-document",
            data: {
              userId,
              sourceId: source.id,
              operationId: receipt.operationId,
            },
            getState,
          }),
        },
      }),
    ).rejects.toThrow(queueError);

    const [after] = await database
      .select()
      .from(sourceIngestionOperations)
      .where(eq(sourceIngestionOperations.operationId, receipt.operationId));
    expect(after).toEqual(before);
    expect(getState).toHaveBeenCalledOnce();
  });

  it.each(["waiting", "active", "delayed"])(
    "does not project a nonterminal retained job in %s state",
    async (state) => {
      const userId = `stalled-receipt-${state}`;
      await database.insert(users).values({ id: userId });
      const [source] = await database
        .insert(sources)
        .values({
          userId,
          type: "document",
          externalId: `${state}-document`,
          status: "pending",
        })
        .returning();
      if (!source) throw new Error("Source missing");
      const receipt = await createSourceIngestionOperation({
        db: database,
        userId,
        sourceId: source.id,
        externalId: source.externalId,
        contentHash: `${state}-document-hash`,
      });
      const processing = await markSourceIngestionProcessing({
        db: database,
        userId,
        sourceId: source.id,
        operationId: receipt.operationId,
      });
      const getState = vi.fn(async () => state);
      const projected = await projectInterruptedSourceProcessing({
        db: database,
        userId,
        operation: processing,
        queue: {
          getJob: async () => ({
            id: receipt.operationId,
            name: "ingest-document",
            data: {
              userId,
              sourceId: source.id,
              operationId: receipt.operationId,
            },
            getState,
          }),
        },
      });
      expect(projected).toEqual(processing);
      expect(getState).toHaveBeenCalledOnce();
    },
  );

  it("ignores a failed job whose retained identity does not match the receipt", async () => {
    const userId = "stalled-receipt-wrong-job";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "wrong-job-document",
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const receipt = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "wrong-job-document-hash",
    });
    const processing = await markSourceIngestionProcessing({
      db: database,
      userId,
      sourceId: source.id,
      operationId: receipt.operationId,
    });
    const getState = vi.fn(async () => "failed");
    const projected = await projectInterruptedSourceProcessing({
      db: database,
      userId,
      operation: processing,
      queue: {
        getJob: async () => ({
          id: receipt.operationId,
          name: "ingest-document",
          data: {
            userId: "another-user",
            sourceId: source.id,
            operationId: receipt.operationId,
          },
          getState,
        }),
      },
    });
    expect(projected).toEqual(processing);
    expect(getState).not.toHaveBeenCalled();
  });

  it.each(["queued", "processing"] as const)(
    "does not change a %s receipt when Redis rejects the supported retry",
    async (status) => {
      const userId = `retry-redis-failure-${status}`;
      await database.insert(users).values({ id: userId });
      const [source] = await database
        .insert(sources)
        .values({
          userId,
          type: "document",
          externalId: `${status}-redis-document`,
          status: "pending",
        })
        .returning();
      if (!source) throw new Error("Source missing");
      const receipt = await createSourceIngestionOperation({
        db: database,
        userId,
        sourceId: source.id,
        externalId: source.externalId,
        contentHash: `${status}-redis-document-hash`,
      });
      const processing =
        status === "processing"
          ? await markSourceIngestionProcessing({
              db: database,
              userId,
              sourceId: source.id,
              operationId: receipt.operationId,
            })
          : receipt;
      worker = new Worker(
        queueName,
        async (): Promise<void> => {
          throw new Error("simulated Redis retry prerequisite failure");
        },
        { connection: queue.opts.connection },
      );
      const job = await queue.add(
        "ingest-document",
        {
          userId,
          sourceId: source.id,
          operationId: receipt.operationId,
        },
        { jobId: receipt.operationId, attempts: 1 },
      );
      await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
        "simulated Redis retry prerequisite failure",
      );
      await worker.close();
      worker = undefined;
      const [before] = await database
        .select()
        .from(sourceIngestionOperations)
        .where(eq(sourceIngestionOperations.operationId, receipt.operationId));
      if (!before) throw new Error("Receipt missing");
      const queueLookup = vi.spyOn(queue, "getJob").mockResolvedValueOnce(job);
      const retry = vi
        .spyOn(job, "retry")
        .mockRejectedValueOnce(new Error("Redis unavailable"));
      try {
        await expect(
          retrySourceProcessing({ userId, operationId: receipt.operationId }),
        ).rejects.toThrow("Redis unavailable");
      } finally {
        retry.mockRestore();
        queueLookup.mockRestore();
      }
      const [after] = await database
        .select()
        .from(sourceIngestionOperations)
        .where(eq(sourceIngestionOperations.operationId, receipt.operationId));
      expect(after).toEqual(before);
      expect(await job.getState()).toBe("failed");
      expect(processing.status).toBe(status);
    },
  );

  it("keeps the worker fence after retry preflight wins the Redis handoff", async () => {
    const userId = "retry-worker-fence-owner";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "worker-fence-document",
        status: "pending",
        metadata: { rawContent: "Current request" },
      })
      .returning();
    if (!source) throw new Error("Source missing");
    const receipt = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "worker-fence-document-hash",
    });
    const input = {
      db: database,
      userId,
      sourceId: source.id,
      operationId: receipt.operationId,
    };
    await markSourceIngestionProcessing(input);
    const extraction = await markSourceIngestionExtractionStarted(input);
    worker = new Worker(
      queueName,
      async (): Promise<void> => {
        throw new Error("simulated worker handoff failure");
      },
      { connection: queue.opts.connection },
    );
    const job = await queue.add(
      "ingest-document",
      {
        userId,
        sourceId: source.id,
        operationId: receipt.operationId,
        expectedSourceVersion: extraction.sourceVersion,
        documentId: "worker-fence-document",
        contentType: "text",
        timestamp: "2026-09-10T10:00:00.000Z",
      },
      { jobId: receipt.operationId, attempts: 1 },
    );
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "simulated worker handoff failure",
    );
    await worker.close();
    worker = undefined;

    const originalRetry = job.retry.bind(job);
    const queueLookup = vi.spyOn(queue, "getJob").mockResolvedValueOnce(job);
    const retry = vi.spyOn(job, "retry").mockImplementation(async (state) => {
      await applySourceLifecycleCommand(
        database,
        sourceLifecycleCommandRequestSchema.parse({
          userId,
          sourceId: source.id,
          expectedPartitionKey: null,
          expectedSourceVersion: extraction.sourceVersion,
          commandId: randomUUID(),
          action: "tombstone",
        }),
      );
      return originalRetry(state);
    });
    try {
      await expect(
        retrySourceProcessing({ userId, operationId: receipt.operationId }),
      ).resolves.toMatchObject({
        processing: { status: "processing" },
      });
    } finally {
      retry.mockRestore();
      queueLookup.mockRestore();
    }
    expect(await job.getState()).toBe("waiting");

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
    await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow(
      "A source was tombstoned before its derived write could be committed",
    );
    expect(extractDocumentGraph).not.toHaveBeenCalled();
    expect(
      await getSourceIngestionOperationById({
        db: database,
        userId,
        operationId: receipt.operationId,
      }),
    ).toMatchObject({ status: "processing", stage: "extraction" });
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

  it("rejects a workspace retry of a legacy receipt during migration before queue access", async () => {
    const userId = "retry-workspace-legacy-migrating";
    const sourceId = newTypeId("source");
    const operationId = `legacy-migrating-${Date.now()}`;
    await database.insert(users).values({ id: userId });
    // Legacy NULL rows are created before the migration fence is installed.
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "legacy-migrating",
      status: "pending",
    });
    await database.insert(sourceIngestionOperations).values({
      operationId,
      userId,
      sourceId,
      externalId: "legacy-migrating",
      sourceVersion: 0,
      status: "queued",
      stage: "content",
    });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
      version: 1,
    });
    const getJob = vi.spyOn(queue, "getJob");
    const add = vi.spyOn(queue, "add");

    await expect(
      retrySourceProcessing({
        userId,
        operationId,
        accessScope: "workspace",
      }),
    ).rejects.toMatchObject({ code: "PARTITION_REQUIRED" });
    expect(getJob).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    await expect(
      database
        .select({ version: sources.version })
        .from(sources)
        .where(eq(sources.id, sourceId)),
    ).resolves.toEqual([{ version: 0 }]);
  });

  it("does not retry an operation in an inactive workspace partition", async () => {
    const userId = "retry-workspace-inactive";
    const partitionKey = contextPartitionKeySchema.parse(
      "retry:inactive-partition",
    );
    const sourceId = newTypeId("source");
    const operationId = `inactive-${Date.now()}`;
    await database.insert(users).values({ id: userId });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrated",
      version: 1,
    });
    await database.insert(memoryPartitions).values({
      userId,
      partitionKey,
      status: "quarantined",
    });
    // The source-partition trigger blocks creating new rows in quarantine.
    // Seed the retained historical operation behind a test-only trigger
    // bypass, then verify retry still refuses it before touching BullMQ.
    await client.query(`ALTER TABLE "sources" DISABLE TRIGGER USER`);
    try {
      await database.insert(sources).values({
        id: sourceId,
        userId,
        partitionKey,
        type: "document",
        externalId: "inactive-partition",
        status: "pending",
      });
    } finally {
      await client.query(`ALTER TABLE "sources" ENABLE TRIGGER USER`);
    }
    await database.insert(sourceIngestionOperations).values({
      operationId,
      userId,
      sourceId,
      partitionKey,
      externalId: "inactive-partition",
      sourceVersion: 0,
      status: "queued",
      stage: "content",
    });
    const getJob = vi.spyOn(queue, "getJob");
    const add = vi.spyOn(queue, "add");

    await expect(
      retrySourceProcessing({
        userId,
        operationId,
        accessScope: "workspace",
      }),
    ).rejects.toMatchObject({ code: "PARTITION_UNAUTHORIZED" });
    expect(getJob).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});
