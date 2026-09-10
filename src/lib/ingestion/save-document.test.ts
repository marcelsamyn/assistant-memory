import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  memoryChangeFeedEvents,
  partitionMigrationState,
  memoryPartitions,
  nodes,
  sourceLinks,
  sourceTombstones,
  sources,
  users,
} from "~/db/schema";
import { contextualSourceExternalId } from "~/lib/ingestion/source-identity";
import { queryChangeFeed } from "~/lib/query/change-feed";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { newTypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";

vi.hoisted(() => {
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
    vi.doMock("~/lib/sources", () => ({
      sourceBlobObjectKey: (userId: string, sourceId: string) =>
        `${userId}/${sourceId}`,
      sourceService: {
        deleteRawBlobIfPresent,
        replaceInlineContent: async (input: {
          userId: string;
          sourceId: schema.SourcesSelect["id"];
          content: string;
          metadata: Record<string, unknown>;
          parentId?: schema.SourcesSelect["id"];
          scope: schema.SourcesSelect["scope"];
          timestamp: Date;
          replaceDerivedLinks?: boolean;
          status?: schema.SourcesSelect["status"];
        }) => {
          const [updated] = await database
            .update(sources)
            .set({
              metadata: { ...input.metadata, rawContent: input.content },
              parentSource: input.parentId ?? null,
              scope: input.scope,
              lastIngestedAt: input.timestamp,
              ...(input.status !== undefined ? { status: input.status } : {}),
            })
            .where(
              and(
                eq(sources.userId, input.userId),
                eq(sources.id, input.sourceId),
              ),
            )
            .returning({ version: sources.version });
          if (input.replaceDerivedLinks) {
            await database
              .delete(sourceLinks)
              .where(eq(sourceLinks.sourceId, input.sourceId));
          }
          return updated?.version ?? 0;
        },
        insertMany: async (
          inputs: Array<{
            userId: string;
            sourceType: schema.SourcesInsert["type"];
            externalId: string;
            partitionKey?: schema.SourcesInsert["partitionKey"];
            scope?: schema.SourcesInsert["scope"];
            timestamp: Date;
            content?: string;
            metadata?: Record<string, unknown>;
          }>,
        ) => {
          const successes = [] as Array<schema.SourcesSelect["id"]>;
          for (const input of inputs) {
            const [source] = await database
              .insert(sources)
              .values({
                id: newTypeId("source"),
                userId: input.userId,
                type: input.sourceType,
                externalId: input.externalId,
                partitionKey: input.partitionKey ?? null,
                scope: input.scope ?? "personal",
                metadata: {
                  ...input.metadata,
                  ...(input.content === undefined
                    ? {}
                    : { rawContent: input.content }),
                },
                lastIngestedAt: input.timestamp,
                status: "completed",
              })
              .onConflictDoNothing({
                target: [sources.userId, sources.type, sources.externalId],
              })
              .returning({ id: sources.id });
            if (source) successes.push(source.id);
          }
          return { successes, failures: [] };
        },
      },
    }));
    ({ saveMemory } = await import("./save-document"));
  }, 120_000);

  afterAll(async () => {
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
          rawContent: "revised attachment",
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
});
