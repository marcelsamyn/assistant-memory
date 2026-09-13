import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  memoryChangeFeedEvents,
  partitionMigrationState,
  memoryPartitions,
  nodes,
  sourceLinks,
  sourceIngestionOperations,
  sourceIdentityTombstones,
  sourceTombstones,
  sources,
  users,
} from "~/db/schema";
import { contextualSourceExternalId } from "~/lib/ingestion/source-identity";
import {
  advanceSourceIngestionOperationVersion,
  completeSourceIngestionOperation,
  getSourceIngestionOperationById,
  markSourceIngestionProcessing,
  hashSourceContent,
} from "~/lib/ingestion/source-processing";
import { hashSourceExtractionRevision } from "~/lib/ingestion/source-revision";
import {
  reclassifySourcePartition,
  setPartitionMigrationState,
} from "~/lib/partition-reclassification";
import { queryChangeFeed } from "~/lib/query/change-feed";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { applySourceIdentityLifecycle } from "~/lib/source-identity-lifecycle";
import { SourceService } from "~/lib/sources";
import { contextualSourceExternalId as sdkContextualSourceExternalId } from "~/sdk/index";
import { newTypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";

vi.hoisted(() => {
  vi.resetModules();
  process.env["DATABASE_URL"] ??=
    "postgres://postgres:postgres@localhost:5431/postgres";
  process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
  process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
  process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
  process.env["JINA_API_KEY"] ??= "test";
  process.env["REDIS_URL"] ??= "redis://localhost:6380";
  process.env["MINIO_ENDPOINT"] ??= "localhost";
  process.env["MINIO_ACCESS_KEY"] ??= "minio";
  process.env["MINIO_SECRET_KEY"] ??= "minio123";
  process.env["SOURCES_BUCKET"] ??= "save-document-replacement-test";
});

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (name: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${name}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

describeIfServer("document replacement source lifecycle", () => {
  const dbName = `memory_document_replacement_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;
  let database: NodePgDatabase<typeof schema>;
  let saveMemory: (typeof import("./save-document"))["saveMemory"];
  let service: SourceService;
  const deleteRawBlobIfPresent = vi.fn(async () => undefined);
  const addIngestionJob = vi.fn(async () => undefined);

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    setTestDatabase(database);

    vi.doMock("~/db", () => ({ default: database }));
    vi.doMock("~/lib/queues", () => ({
      batchQueue: { add: addIngestionJob },
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async ({ input }: { input: string[] }) => ({
        data: input.map(() => ({
          embedding: Array.from({ length: 1024 }, () => 0.02),
        })),
      }),
    }));
    service = new SourceService(
      database,
      new MinioClient({
        endPoint: "localhost",
        port: 9000,
        useSSL: false,
        accessKey: "unused",
        secretKey: "unused",
      }),
      "save-document-test",
    );
    vi.spyOn(MinioClient.prototype, "bucketExists").mockResolvedValue(true);
    vi.spyOn(service, "deleteRawBlobIfPresent").mockImplementation(
      deleteRawBlobIfPresent,
    );
    vi.doMock("~/lib/sources", async () => ({
      ...(await vi.importActual<typeof import("~/lib/sources")>(
        "~/lib/sources",
      )),
      sourceService: service,
    }));
    ({ saveMemory } = await import("./save-document"));
  }, 120_000);

  afterAll(async () => {
    vi.doUnmock("~/lib/embeddings");
    vi.doUnmock("~/db");
    vi.doUnmock("~/lib/sources");
    vi.doUnmock("~/lib/queues");
    vi.resetModules();
    setTestDatabase(null);
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("redacts a replaced document before assigning its external id to a fresh source", async () => {
    const userId = "document-replacement-user";
    const oldSourceId = newTypeId("source");
    const oldNodeId = newTypeId("node");
    const erasedSecret = "the original document must not survive replacement";
    await database.insert(users).values({ id: userId });
    await database.insert(nodes).values({
      id: oldNodeId,
      userId,
      nodeType: "Task",
    });
    await database.insert(sources).values({
      id: oldSourceId,
      userId,
      type: "document",
      externalId: "replace-me",
      metadata: { rawContent: erasedSecret },
      status: "completed",
    });
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId: oldSourceId,
      nodeId: oldNodeId,
    });

    const replacement = await saveMemory({
      userId,
      updateExisting: true,
      document: {
        id: "replace-me",
        content: "fresh document content",
        contentType: "text",
        scope: "personal",
      },
    });

    expect(replacement.sourceId).not.toBe(oldSourceId);
    expect(deleteRawBlobIfPresent).toHaveBeenCalledWith(userId, oldSourceId);
    expect(addIngestionJob).toHaveBeenCalledOnce();
    await expect(
      database
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.id, oldSourceId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, oldNodeId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({ state: sourceTombstones.state })
        .from(sourceTombstones)
        .where(eq(sourceTombstones.sourceId, oldSourceId)),
    ).resolves.toEqual([{ state: "restored" }]);
    const feed = await queryChangeFeed({ userId, limit: 500 });
    expect(JSON.stringify(feed.events)).not.toContain(erasedSecret);
    const rawEvents = await database
      .select({ sourceId: memoryChangeFeedEvents.sourceId })
      .from(memoryChangeFeedEvents)
      .where(
        and(
          eq(memoryChangeFeedEvents.userId, userId),
          eq(memoryChangeFeedEvents.sourceId, oldSourceId),
        ),
      );
    expect(rawEvents.length).toBeGreaterThan(0);
  });

  it("reports a document identity owned by another partition as a conflict", async () => {
    addIngestionJob.mockClear();
    const userId = "document-partition-conflict";
    const partitionA = contextPartitionKeySchema.parse("opaque:document-a");
    const partitionB = contextPartitionKeySchema.parse("opaque:document-b");
    await database.insert(users).values({ id: userId });
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA },
      { userId, partitionKey: partitionB },
    ]);
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
    });
    await database.insert(sources).values({
      id: newTypeId("source"),
      userId,
      type: "document",
      externalId: "shared-document-id",
      partitionKey: partitionA,
      status: "completed",
    });

    await expect(
      saveMemory({
        userId,
        partitionKey: partitionB,
        updateExisting: false,
        document: {
          id: "shared-document-id",
          content: "new partition content",
          contentType: "text",
          scope: "personal",
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      statusMessage:
        "document source already belongs to a different memory partition",
    });
    expect(addIngestionJob).not.toHaveBeenCalled();
  });

  it("uses personal for workspace roots and inherits a parent source partition", async () => {
    addIngestionJob.mockClear();
    const userId = "document-workspace-inheritance";
    await database.insert(users).values({ id: userId });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrated",
    });

    const root = await saveMemory({
      userId,
      accessScope: "workspace",
      updateExisting: false,
      document: {
        id: "workspace-root",
        content: "root content",
        contentType: "text",
        scope: "personal",
      },
    });
    const child = await saveMemory({
      userId,
      accessScope: "workspace",
      updateExisting: false,
      document: {
        id: "workspace-child",
        content: "child content",
        contentType: "text",
        scope: "personal",
        sourceContext: {
          version: 1,
          sourceKind: "email_attachment",
          purpose: "Attachment to the workspace root",
          accountId: "workspace-account",
          relationship: "recipient",
          currentMessageRole: "attachment",
          completeness: "complete",
          parentSourceId: root.sourceId,
        },
      },
    });

    const rows = await database
      .select({ id: sources.id, partitionKey: sources.partitionKey })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          sql`${sources.id} IN (${root.sourceId}, ${child.sourceId})`,
        ),
      );
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.partitionKey))).toEqual(
      new Set(["memory:personal"]),
    );
  });

  it("keeps contextual source identity and persists revised ingestion metadata", async () => {
    addIngestionJob.mockClear();
    const userId = "document-contextual-revision";
    const sourceId = newTypeId("source");
    const parentId = newTypeId("source");
    const sourceContext = {
      version: 1 as const,
      sourceKind: "email_attachment" as const,
      purpose: "Attachment to the current email",
      accountId: "mail-account",
      relationship: "recipient",
      currentMessageRole: "attachment" as const,
      completeness: "complete" as const,
      parentSourceId: parentId,
    };
    const externalId = contextualSourceExternalId({
      externalId: "attachment-1",
      accountId: sourceContext.accountId,
    });
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: parentId,
        userId,
        type: "document",
        externalId: "parent",
        status: "completed",
      },
      {
        id: sourceId,
        userId,
        type: "document",
        externalId,
        metadata: { rawContent: "old", title: "Old" },
        status: "completed",
      },
    ]);
    const timestamp = new Date("2026-09-10T09:00:00.000Z");

    const revision = await saveMemory({
      userId,
      updateExisting: true,
      document: {
        id: "attachment-1",
        content: "revised attachment",
        contentType: "text",
        scope: "reference",
        timestamp,
        title: "Current title",
        author: "Current author",
        sourceContext,
      },
    });

    expect(revision.sourceId).toBe(sourceId);
    expect(deleteRawBlobIfPresent).not.toHaveBeenCalledWith(userId, sourceId);
    expect(addIngestionJob).toHaveBeenCalledOnce();
    await expect(
      database
        .select({
          id: sources.id,
          parentSource: sources.parentSource,
          scope: sources.scope,
          metadata: sources.metadata,
          lastIngestedAt: sources.lastIngestedAt,
        })
        .from(sources)
        .where(eq(sources.id, sourceId)),
    ).resolves.toEqual([
      {
        id: sourceId,
        parentSource: parentId,
        scope: "reference",
        metadata: {
          ingestionRevisionHash: hashSourceExtractionRevision(
            hashSourceContent("revised attachment"),
            sourceContext,
            {
              scope: "reference",
              contentType: "text",
              author: "Current author",
              timestamp,
            },
          ),
          rawContent: "revised attachment",
          documentIngestion: {
            documentId: "attachment-1",
            contentType: "text",
          },
          title: "Current title",
          author: "Current author",
          sourceContext,
        },
        lastIngestedAt: timestamp,
      },
    ]);

    const metadataOnlyRevision = await saveMemory({
      userId,
      updateExisting: true,
      document: {
        id: "attachment-1",
        content: "revised attachment",
        contentType: "text",
        scope: "reference",
        timestamp,
        title: "Metadata-only title",
        author: "Current author",
        sourceContext,
      },
    });
    expect(metadataOnlyRevision).toMatchObject({
      sourceId,
      ingestionOperationId: revision.ingestionOperationId,
    });
    expect(addIngestionJob).toHaveBeenCalledTimes(2);
    await expect(
      database
        .select({ metadata: sources.metadata })
        .from(sources)
        .where(eq(sources.id, sourceId)),
    ).resolves.toEqual([
      {
        metadata: expect.objectContaining({ title: "Metadata-only title" }),
      },
    ]);
  });

  it("updates the linked Document node on a completed title-only replay", async () => {
    addIngestionJob.mockClear();
    const userId = "document-title-only-replay";
    const sourceContext = {
      version: 1 as const,
      sourceKind: "email" as const,
      purpose: "Keep the source title current",
      accountId: "title-account",
      relationship: "recipient" as const,
      currentMessageRole: "current" as const,
      completeness: "complete" as const,
    };
    const request = {
      userId,
      updateExisting: true,
      document: {
        id: "title-message",
        content: "same source content",
        contentType: "text" as const,
        scope: "personal" as const,
        title: "Original title",
        sourceContext,
      },
    };
    const accepted = await saveMemory(request);
    const processingInput = {
      db: database,
      userId,
      sourceId: accepted.sourceId,
      operationId: accepted.ingestionOperationId!,
    };
    const processing = await markSourceIngestionProcessing(processingInput);
    await completeSourceIngestionOperation({
      ...processingInput,
      expectedSourceVersion: processing.sourceVersion,
    });
    const documentNodeId = newTypeId("node");
    await database.insert(nodes).values({
      id: documentNodeId,
      userId,
      nodeType: "Document",
    });
    await database.insert(sourceLinks).values({
      sourceId: accepted.sourceId,
      nodeId: documentNodeId,
    });
    await database.insert(schema.nodeMetadata).values({
      nodeId: documentNodeId,
      label: "Original title",
      canonicalLabel: "original title",
    });

    await saveMemory({
      ...request,
      document: { ...request.document, title: "Corrected title" },
    });
    const [metadata] = await database
      .select({ label: schema.nodeMetadata.label })
      .from(schema.nodeMetadata)
      .where(eq(schema.nodeMetadata.nodeId, documentNodeId));
    expect(metadata?.label).toBe("Corrected title");
    expect(addIngestionJob).toHaveBeenCalledOnce();
  });

  it.each(["queued", "processing", "completed"] as const)(
    "keeps an identical contextual HTML replay unchanged while %s",
    async (status) => {
      addIngestionJob.mockClear();
      const request = {
        userId: `document-html-replay-${status}`,
        updateExisting: true,
        document: {
          id: "html-message",
          content: "<p>Keep the converted text.</p>",
          contentType: "html" as const,
          scope: "personal" as const,
          sourceContext: {
            version: 1 as const,
            sourceKind: "email" as const,
            purpose: "Find relevant requests",
            accountId: "mail-account",
            relationship: "recipient",
            currentMessageRole: "current" as const,
            completeness: "complete" as const,
          },
        },
      };
      const accepted = await saveMemory(request);
      const operationId = accepted.ingestionOperationId!;
      const operationInput = {
        db: database,
        userId: request.userId,
        sourceId: accepted.sourceId,
        operationId,
      };
      if (status !== "queued") {
        await markSourceIngestionProcessing(operationInput);
        const [converted] = await database
          .update(sources)
          .set({
            metadata: sql`${sources.metadata} || ${JSON.stringify({ convertedMarkdown: "Keep the converted text.", convertedToMarkdown: true, title: "Converter title" })}::jsonb`,
          })
          .where(eq(sources.id, accepted.sourceId))
          .returning({ version: sources.version });
        await advanceSourceIngestionOperationVersion({
          ...operationInput,
          sourceVersion: converted!.version,
        });
        if (status === "completed") {
          await completeSourceIngestionOperation(operationInput);
        }
      }
      const before = await database
        .select()
        .from(sources)
        .where(eq(sources.id, accepted.sourceId));
      const processingBefore =
        await getSourceIngestionOperationById(operationInput);
      const replay = await saveMemory(request);
      expect(replay.ingestionOperationId).toBe(operationId);
      expect(
        await database
          .select()
          .from(sources)
          .where(eq(sources.id, accepted.sourceId)),
      ).toEqual(before);
      expect(await getSourceIngestionOperationById(operationInput)).toEqual(
        processingBefore,
      );
      if (status !== "completed") {
        expect(
          await markSourceIngestionProcessing(operationInput),
        ).toMatchObject({ status: "processing", errorCode: null });
      }
      expect(addIngestionJob).toHaveBeenCalledTimes(
        status === "queued" ? 2 : 1,
      );
    },
  );

  it("uses the SDK canonical identity to retire and restore a contextual document", async () => {
    const request = {
      userId: "document-sdk-identity",
      updateExisting: true,
      partitionKey: contextPartitionKeySchema.parse("radar:identity"),
      document: {
        id: "gmail:message-42",
        content: "A contextual message",
        contentType: "text" as const,
        scope: "personal" as const,
        sourceContext: {
          version: 1 as const,
          sourceKind: "email" as const,
          purpose: "Find relevant requests",
          accountId: "account-1",
          relationship: "recipient",
          currentMessageRole: "current" as const,
          completeness: "complete" as const,
        },
      },
    };
    await database.insert(users).values({ id: request.userId });
    await database
      .insert(partitionMigrationState)
      .values({ userId: request.userId, state: "migrated" });
    const accepted = await saveMemory(request);
    const externalId = sdkContextualSourceExternalId({
      externalId: request.document.id,
      accountId: request.document.sourceContext.accountId,
      partitionKey: request.partitionKey,
    });
    const identity = {
      userId: request.userId,
      partitionKey: request.partitionKey,
      identities: [{ type: "document" as const, externalId }],
    };
    const retired = await applySourceIdentityLifecycle(database, {
      ...identity,
      action: "retire",
    });
    expect(retired.sources).toEqual([
      expect.objectContaining({ sourceId: accepted.sourceId, externalId }),
    ]);
    await expect(saveMemory(request)).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_RETIRED",
    });
    await applySourceIdentityLifecycle(database, {
      ...identity,
      action: "restore",
    });
    expect((await saveMemory(request)).sourceId).toBe(accepted.sourceId);
  });

  it("rejects a receipt if another document revision commits before acceptance", async () => {
    const request = {
      userId: "document-revision-race",
      updateExisting: true,
      document: {
        id: "same-message",
        content: "initial",
        contentType: "text" as const,
        scope: "personal" as const,
        sourceContext: {
          version: 1 as const,
          sourceKind: "email" as const,
          purpose: "Find requests",
          accountId: "account",
          relationship: "recipient",
          currentMessageRole: "current" as const,
          completeness: "complete" as const,
        },
      },
    };
    const initial = await saveMemory(request);
    const replace = service.replaceInlineContent.bind(service);
    const interleave = vi
      .spyOn(service, "replaceInlineContent")
      .mockImplementation(async (input) => {
        const version = await replace(input);
        if (input.content === "revision A") {
          await saveMemory({
            ...request,
            document: { ...request.document, content: "revision B" },
          });
        }
        return version;
      });
    try {
      await expect(
        saveMemory({
          ...request,
          document: { ...request.document, content: "revision A" },
        }),
      ).rejects.toMatchObject({ code: "SOURCE_VERSION_CONFLICT" });
    } finally {
      interleave.mockRestore();
    }
    const receipts = await database
      .select()
      .from(sourceIngestionOperations)
      .where(eq(sourceIngestionOperations.sourceId, initial.sourceId));
    expect(receipts.map((receipt) => receipt.contentHash)).toEqual(
      expect.arrayContaining([null, expect.any(String)]),
    );
    expect(receipts).toHaveLength(2);
    expect(await service.fetchText(request.userId, initial.sourceId)).toBe(
      "revision B",
    );
  });

  it.each(["queued", "processing"] as const)(
    "keeps changed metadata recoverable during %s processing",
    async (status) => {
      const request = {
        userId: `document-metadata-recovery-${status}`,
        updateExisting: true,
        document: {
          id: "message",
          content: "unchanged bytes",
          contentType: "text" as const,
          scope: "personal" as const,
          sourceContext: {
            version: 1 as const,
            sourceKind: "email" as const,
            purpose: "Find requests",
            accountId: "account",
            relationship: "recipient",
            currentMessageRole: "current" as const,
            completeness: "complete" as const,
          },
        },
      };
      const accepted = await saveMemory(request);
      const input = {
        db: database,
        userId: request.userId,
        sourceId: accepted.sourceId,
        operationId: accepted.ingestionOperationId!,
      };
      if (status === "processing") await markSourceIngestionProcessing(input);
      const replay = await saveMemory({
        ...request,
        document: {
          ...request.document,
          title: "Corrected title",
        },
      });
      expect(replay.ingestionOperationId).toBe(input.operationId);
      const receipt = await getSourceIngestionOperationById(input);
      const [source] = await database
        .select()
        .from(sources)
        .where(eq(sources.id, accepted.sourceId));
      expect(receipt?.sourceVersion).toBe(source?.version);
      const resumed = await markSourceIngestionProcessing(input);
      expect(resumed).toMatchObject({ status: "processing", errorCode: null });
      expect(
        await completeSourceIngestionOperation({
          ...input,
          expectedSourceVersion: resumed.sourceVersion,
        }),
      ).toMatchObject({ status: "completed" });
    },
  );

  it("rejects a stale identical-content replacement after its receipt was accepted", async () => {
    const request = {
      userId: "document-identical-revision-race",
      updateExisting: true,
      document: {
        id: "message",
        content: "initial",
        contentType: "text" as const,
        scope: "personal" as const,
        sourceContext: {
          version: 1 as const,
          sourceKind: "email" as const,
          purpose: "Find requests",
          accountId: "account",
          relationship: "recipient",
          currentMessageRole: "current" as const,
          completeness: "complete" as const,
        },
      },
    };
    const initial = await saveMemory(request);
    const replace = service.replaceInlineContent.bind(service);
    let interleaved = false;
    const interleave = vi
      .spyOn(service, "replaceInlineContent")
      .mockImplementation(async (input) => {
        if (!interleaved) {
          interleaved = true;
          await saveMemory({
            ...request,
            document: {
              ...request.document,
              content: "revision",
              title: "Accepted title",
            },
          });
        }
        return replace(input);
      });
    try {
      await expect(
        saveMemory({
          ...request,
          document: {
            ...request.document,
            content: "revision",
            title: "Stale title",
          },
        }),
      ).rejects.toMatchObject({ code: "SOURCE_VERSION_CONFLICT" });
    } finally {
      interleave.mockRestore();
    }
    const replay = await saveMemory({
      ...request,
      document: {
        ...request.document,
        content: "revision",
        title: "Retried title",
      },
    });
    expect(replay.sourceId).toBe(initial.sourceId);
    const input = {
      db: database,
      userId: request.userId,
      sourceId: replay.sourceId,
      operationId: replay.ingestionOperationId!,
    };
    const resumed = await markSourceIngestionProcessing(input);
    expect(resumed).toMatchObject({ status: "processing", errorCode: null });
    expect(
      await completeSourceIngestionOperation({
        ...input,
        expectedSourceVersion: resumed.sourceVersion,
      }),
    ).toMatchObject({ status: "completed" });
  });
  it("keeps contextual source, child, receipt, and retirement identities through partition moves", async () => {
    const userId = "contextual-partition-rekey";
    const partitionA = contextPartitionKeySchema.parse("context:partition-a");
    const partitionB = contextPartitionKeySchema.parse("context:partition-b");
    const partitionC = contextPartitionKeySchema.parse("context:partition-c");
    const sourceContext = {
      version: 1 as const,
      sourceKind: "email" as const,
      purpose: "Read requests",
      accountId: "account",
      relationship: "recipient",
      currentMessageRole: "current" as const,
      completeness: "complete" as const,
    };
    const request = {
      userId,
      partitionKey: partitionA,
      updateExisting: true,
      document: {
        id: "message",
        content: "body",
        contentType: "text" as const,
        scope: "personal" as const,
        sourceContext,
      },
    };
    await setPartitionMigrationState(database, {
      userId,
      expectedState: "unmigrated",
      expectedVersion: 0,
      nextState: "migrating",
    });
    const accepted = await saveMemory(request);
    const childRequest = {
      ...request,
      document: {
        ...request.document,
        id: "attachment",
        sourceContext: {
          ...sourceContext,
          sourceKind: "email_attachment" as const,
          parentSourceId: accepted.sourceId,
          parentPartitionKey: partitionA,
          currentMessageRole: "attachment" as const,
        },
      },
    };
    const child = await saveMemory(childRequest);
    const [source] = await database
      .select()
      .from(sources)
      .where(eq(sources.id, accepted.sourceId));
    if (!source) throw new Error("Source missing");
    const move = await reclassifySourcePartition(database, {
      userId,
      sourceId: source.id,
      expectedPartitionKey: partitionA,
      expectedSourceVersion: source.version,
      targetPartitionKey: partitionB,
      bindingGeneration: "context-move-b",
    });
    const replay = await saveMemory({ ...request, partitionKey: partitionB });
    expect(replay).toMatchObject({
      sourceId: accepted.sourceId,
      ingestionOperationId: accepted.ingestionOperationId,
    });
    const childReplay = await saveMemory({
      ...childRequest,
      partitionKey: partitionB,
      document: {
        ...childRequest.document,
        sourceContext: {
          ...childRequest.document.sourceContext,
          parentPartitionKey: partitionB,
        },
      },
    });
    expect(childReplay).toMatchObject({
      sourceId: child.sourceId,
      ingestionOperationId: child.ingestionOperationId,
    });
    const canonicalB = contextualSourceExternalId({
      externalId: "message",
      accountId: "account",
      partitionKey: partitionB,
    });
    expect(
      await database
        .select({ externalId: sourceIngestionOperations.externalId })
        .from(sourceIngestionOperations)
        .where(eq(sourceIngestionOperations.sourceId, source.id)),
    ).toEqual([{ externalId: canonicalB }]);
    await applySourceIdentityLifecycle(database, {
      userId,
      partitionKey: partitionB,
      identities: [{ type: "document", externalId: canonicalB }],
      action: "retire",
    });
    await reclassifySourcePartition(database, {
      userId,
      sourceId: source.id,
      expectedPartitionKey: partitionB,
      expectedSourceVersion: move.sourceVersion,
      targetPartitionKey: partitionC,
      bindingGeneration: "context-move-c",
    });
    const canonicalC = contextualSourceExternalId({
      externalId: "message",
      accountId: "account",
      partitionKey: partitionC,
    });
    expect(
      await database
        .select({
          externalId: sourceIdentityTombstones.externalId,
          partitionKey: sourceIdentityTombstones.partitionKey,
        })
        .from(sourceIdentityTombstones)
        .where(eq(sourceIdentityTombstones.userId, userId)),
    ).toEqual(
      expect.arrayContaining([
        { externalId: canonicalB, partitionKey: partitionB },
        { externalId: canonicalC, partitionKey: partitionC },
      ]),
    );
    await applySourceIdentityLifecycle(database, {
      userId,
      partitionKey: partitionC,
      identities: [{ type: "document", externalId: canonicalC }],
      action: "restore",
    });
    expect(
      (await saveMemory({ ...request, partitionKey: partitionC })).sourceId,
    ).toBe(source.id);
    expect(
      await database
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.userId, userId)),
    ).toHaveLength(2);
  });

  it.each(["source", "retirement"] as const)(
    "rolls back a contextual move into an occupied %s identity",
    async (occupied) => {
      const userId = `context-collision-${occupied}`;
      const partitionA = contextPartitionKeySchema.parse("collision:a");
      const partitionB = contextPartitionKeySchema.parse("collision:b");
      const sourceContext = {
        version: 1 as const,
        sourceKind: "email" as const,
        purpose: "Read requests",
        accountId: "account",
        relationship: "recipient",
        currentMessageRole: "current" as const,
        completeness: "complete" as const,
      };
      await setPartitionMigrationState(database, {
        userId,
        expectedState: "unmigrated",
        expectedVersion: 0,
        nextState: "migrating",
      });
      const request = {
        userId,
        partitionKey: partitionA,
        updateExisting: true,
        document: {
          id: "message",
          content: "body",
          contentType: "text" as const,
          scope: "personal" as const,
          sourceContext,
        },
      };
      const accepted = await saveMemory(request);
      if (occupied === "source")
        await saveMemory({ ...request, partitionKey: partitionB });
      else
        await applySourceIdentityLifecycle(database, {
          userId,
          partitionKey: partitionB,
          identities: [
            {
              type: "document",
              externalId: contextualSourceExternalId({
                externalId: "message",
                accountId: "account",
                partitionKey: partitionB,
              }),
            },
          ],
          action: "retire",
        });
      const [source] = await database
        .select()
        .from(sources)
        .where(eq(sources.id, accepted.sourceId));
      if (!source) throw new Error("Source missing");
      await expect(
        reclassifySourcePartition(database, {
          userId,
          sourceId: source.id,
          expectedPartitionKey: partitionA,
          expectedSourceVersion: source.version,
          targetPartitionKey: partitionB,
          bindingGeneration: "conflict",
        }),
      ).rejects.toMatchObject({ code: "SOURCE_PARTITION_CONFLICT" });
      expect(
        await database.select().from(sources).where(eq(sources.id, source.id)),
      ).toEqual([source]);
      expect(
        await getSourceIngestionOperationById({
          db: database,
          userId,
          operationId: accepted.ingestionOperationId!,
          partitionKey: partitionA,
        }),
      ).toMatchObject({ partitionKey: partitionA });
    },
  );
  it("keeps the old retirement closed after moving and restoring the destination", async () => {
    const userId = "retired-contextual-move";
    const partitionA = contextPartitionKeySchema.parse("retired:a");
    const partitionB = contextPartitionKeySchema.parse("retired:b");
    const sourceContext = {
      version: 1 as const,
      sourceKind: "email" as const,
      purpose: "Read requests",
      accountId: "account",
      relationship: "recipient",
      currentMessageRole: "current" as const,
      completeness: "complete" as const,
    };
    const request = {
      userId,
      partitionKey: partitionA,
      updateExisting: true,
      document: {
        id: "message",
        content: "retained content",
        contentType: "text" as const,
        scope: "personal" as const,
        sourceContext,
      },
    };
    await setPartitionMigrationState(database, {
      userId,
      expectedState: "unmigrated",
      expectedVersion: 0,
      nextState: "migrating",
    });
    const accepted = await saveMemory(request);
    const canonicalA = contextualSourceExternalId({
      externalId: "message",
      accountId: "account",
      partitionKey: partitionA,
    });
    const canonicalB = contextualSourceExternalId({
      externalId: "message",
      accountId: "account",
      partitionKey: partitionB,
    });
    await applySourceIdentityLifecycle(database, {
      userId,
      partitionKey: partitionA,
      identities: [{ type: "document", externalId: canonicalA }],
      action: "retire",
    });
    const [source] = await database
      .select()
      .from(sources)
      .where(eq(sources.id, accepted.sourceId));
    if (!source) throw new Error("Source missing");
    await reclassifySourcePartition(database, {
      userId,
      sourceId: source.id,
      expectedPartitionKey: partitionA,
      expectedSourceVersion: source.version,
      targetPartitionKey: partitionB,
      bindingGeneration: "retired-move",
    });
    await expect(saveMemory(request)).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_RETIRED",
    });
    const destinationRequest = { ...request, partitionKey: partitionB };
    await expect(saveMemory(destinationRequest)).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_RETIRED",
    });
    await applySourceIdentityLifecycle(database, {
      userId,
      partitionKey: partitionB,
      identities: [{ type: "document", externalId: canonicalB }],
      action: "restore",
    });
    expect(await saveMemory(destinationRequest)).toMatchObject({
      sourceId: accepted.sourceId,
      ingestionOperationId: accepted.ingestionOperationId,
    });
    await expect(saveMemory(request)).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_RETIRED",
    });
    expect(
      await database
        .select({
          externalId: sourceIdentityTombstones.externalId,
          partitionKey: sourceIdentityTombstones.partitionKey,
        })
        .from(sourceIdentityTombstones)
        .where(eq(sourceIdentityTombstones.userId, userId)),
    ).toEqual([{ externalId: canonicalA, partitionKey: partitionA }]);
    expect(
      await database
        .select({ id: sources.id })
        .from(sources)
        .where(eq(sources.userId, userId)),
    ).toEqual([{ id: accepted.sourceId }]);
  });
});
