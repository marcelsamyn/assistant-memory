import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  nodes,
  sourceIngestionOperations,
  sourceLinks,
  sources,
  users,
} from "~/db/schema";
import {
  completeSourceIngestionOperation,
  createSourceIngestionOperation,
  getSourceIngestionOperationById,
  markSourceIngestionProcessing,
  purgeSourceIngestionOperations,
} from "~/lib/ingestion/source-processing";
import { SourceService } from "~/lib/sources";
import { newTypeId } from "~/types/typeid";

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

describeIfServer("source ingestion operation integration", () => {
  const dbName = `memory_source_processing_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;
  let database: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 120_000);

  afterAll(async () => {
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

  async function createSource(userId: string, externalId: string) {
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        id: newTypeId("source"),
        userId,
        type: "document",
        externalId,
        status: "completed",
      })
      .returning();
    if (!source) throw new Error("Source was not created");
    return source;
  }

  it("moves an accepted operation through queued, processing, and completed", async () => {
    const userId = "processing-transitions-user";
    const source = await createSource(userId, "processing-transitions");
    const queued = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "hash-a",
    });
    expect(queued).toMatchObject({ status: "queued", attempt: 0 });

    const processing = await markSourceIngestionProcessing({
      db: database,
      userId,
      sourceId: source.id,
      operationId: queued.operationId,
    });
    expect(processing).toMatchObject({ status: "processing", attempt: 1 });

    const completed = await completeSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      operationId: queued.operationId,
      expectedSourceVersion: processing.sourceVersion,
    });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it("fails a stale processing retry without changing a newer completed source", async () => {
    const userId = "processing-stale-retry-user";
    const source = await createSource(userId, "processing-stale-retry");
    const oldQueued = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "old-hash",
    });
    await markSourceIngestionProcessing({
      db: database,
      userId,
      sourceId: source.id,
      operationId: oldQueued.operationId,
    });
    const newerQueued = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "new-hash",
    });
    const newerProcessing = await markSourceIngestionProcessing({
      db: database,
      userId,
      sourceId: source.id,
      operationId: newerQueued.operationId,
    });
    await completeSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      operationId: newerQueued.operationId,
      expectedSourceVersion: newerProcessing.sourceVersion,
    });

    const stale = await markSourceIngestionProcessing({
      db: database,
      userId,
      sourceId: source.id,
      operationId: oldQueued.operationId,
    });
    expect(stale).toMatchObject({
      status: "failed",
      errorCode: "SUPERSEDED_OPERATION",
    });
    await expect(
      database
        .select({ status: sources.status })
        .from(sources)
        .where(eq(sources.id, source.id)),
    ).resolves.toEqual([{ status: "completed" }]);
  });

  it("finds a retained operation by id after newer revisions and purge", async () => {
    const userId = "processing-retained-receipt-user";
    const source = await createSource(userId, "processing-retained-receipt");
    const first = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "first-hash",
    });
    await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: "second-hash",
    });
    await database.transaction(async (tx) => {
      await purgeSourceIngestionOperations(tx, userId, [source.id]);
      await tx.delete(sources).where(eq(sources.id, source.id));
    });

    await expect(
      getSourceIngestionOperationById({
        db: database,
        userId,
        operationId: first.operationId,
      }),
    ).resolves.toMatchObject({
      operationId: first.operationId,
      sourceId: source.id,
      status: "purged",
    });
  });

  it("revises mutable metadata and replaces only this source's links", async () => {
    const userId = "processing-metadata-user";
    const source = await createSource(userId, "processing-metadata");
    const parent = await database
      .insert(sources)
      .values({
        id: newTypeId("source"),
        userId,
        type: "document",
        externalId: "processing-metadata-parent",
        status: "completed",
      })
      .returning()
      .then((rows) => rows[0]);
    if (!parent) throw new Error("Parent was not created");
    const other = await database
      .insert(sources)
      .values({
        id: newTypeId("source"),
        userId,
        type: "document",
        externalId: "processing-metadata-other",
        status: "completed",
      })
      .returning()
      .then((rows) => rows[0]);
    if (!other) throw new Error("Other source was not created");
    const nodeId = newTypeId("node");
    await database
      .insert(nodes)
      .values({ id: nodeId, userId, nodeType: "Task" });
    await database.insert(sourceLinks).values([
      { id: newTypeId("source_link"), sourceId: source.id, nodeId },
      { id: newTypeId("source_link"), sourceId: other.id, nodeId },
    ]);
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
    const timestamp = new Date("2026-09-10T08:00:00.000Z");
    const sourceContext = {
      version: 1 as const,
      sourceKind: "document" as const,
      purpose: "Current message context",
      accountId: "account-2",
      relationship: "owner",
      currentMessageRole: "current" as const,
      completeness: "complete" as const,
      parentSourceId: parent.id,
    };
    await service.replaceInlineContent({
      userId,
      sourceId: source.id,
      partitionKey: undefined,
      content: "revised content",
      metadata: { title: "Revised", author: "Writer", sourceContext },
      parentId: parent.id,
      scope: "reference",
      timestamp,
      replaceDerivedLinks: true,
      status: "pending",
    });

    const [revised] = await database
      .select()
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(revised).toMatchObject({
      id: source.id,
      parentSource: parent.id,
      scope: "reference",
      lastIngestedAt: timestamp,
      status: "pending",
      metadata: {
        rawContent: "revised content",
        title: "Revised",
        author: "Writer",
        sourceContext,
      },
    });
    await expect(
      database
        .select({ sourceId: sourceLinks.sourceId })
        .from(sourceLinks)
        .where(eq(sourceLinks.nodeId, nodeId)),
    ).resolves.toEqual([{ sourceId: other.id }]);
    await expect(
      database.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)),
    ).resolves.toEqual([{ id: nodeId }]);
    await expect(
      database
        .select({ operationId: sourceIngestionOperations.operationId })
        .from(sourceIngestionOperations)
        .where(
          and(
            eq(sourceIngestionOperations.userId, userId),
            eq(sourceIngestionOperations.sourceId, source.id),
          ),
        ),
    ).resolves.toEqual([]);
  });
});
