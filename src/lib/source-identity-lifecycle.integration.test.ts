import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client as MinioClient } from "minio";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  sourceIdentityTombstones,
  sources,
  users,
  memoryPartitions,
} from "~/db/schema";
import { lockSourceIdentityGates } from "~/lib/partition-access";
import { setPartitionMigrationState } from "~/lib/partition-migration";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { applySourceIdentityLifecycle } from "~/lib/source-identity-lifecycle";
import { SourceService } from "~/lib/sources";

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
  process.env["SOURCES_BUCKET"] ??= "source-identity-test";
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

async function isPostgresReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const describeIfPostgres = (await isPostgresReachable())
  ? describe
  : describe.skip;

describeIfPostgres("source identity lifecycle", () => {
  const dbName = `memory_source_identity_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let firstClient: Client;
  let secondClient: Client;
  let firstDb: NodePgDatabase<typeof schema>;
  let secondDb: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    firstClient = new Client({ connectionString: dsnFor(dbName) });
    secondClient = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    firstDb = drizzle(firstClient, { schema, casing: "snake_case" });
    secondDb = drizzle(secondClient, { schema, casing: "snake_case" });
    await migrate(firstDb, { migrationsFolder: "./drizzle" });
    await firstDb.insert(users).values({ id: "user_identity" });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([firstClient.end(), secondClient.end()]);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("returns a source that commits before retirement and rejects later creation", async () => {
    const identity = {
      userId: "user_identity",
      sourceType: "document" as const,
      externalId: "gmail:account:message",
    };
    const inserted = deferred();
    const release = deferred();
    const ingest = firstDb.transaction(async (tx) => {
      await lockSourceIdentityGates(tx, [identity]);
      const [source] = await tx
        .insert(sources)
        .values({
          userId: identity.userId,
          type: identity.sourceType,
          externalId: identity.externalId,
          status: "completed",
          lastIngestedAt: new Date("2026-09-10T08:00:00Z"),
        })
        .returning({ sourceId: sources.id });
      inserted.resolve();
      await release.promise;
      return source!;
    });
    await inserted.promise;

    let retirementSettled = false;
    const retirement = applySourceIdentityLifecycle(secondDb, {
      userId: identity.userId,
      identities: [
        { type: identity.sourceType, externalId: identity.externalId },
      ],
      action: "retire",
    }).finally(() => {
      retirementSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(retirementSettled).toBe(false);
    release.resolve();
    const [{ sourceId }, retired] = await Promise.all([ingest, retirement]);
    expect(retired.sources[0]?.sourceId).toBe(sourceId);

    const minio = {
      bucketExists: vi.fn().mockResolvedValue(true),
    } as unknown as MinioClient;
    const service = new SourceService(secondDb, minio, "unused");
    await expect(
      service.insertMany([
        {
          ...identity,
          sourceType: identity.sourceType,
          timestamp: new Date("2026-09-10T08:01:00Z"),
          content: "late content",
        },
      ]),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_RETIRED" });
    await expect(
      service.replaceInlineContent({
        userId: identity.userId,
        sourceId,
        partitionKey: undefined,
        content: "late revision",
        metadata: {},
        scope: "personal",
        timestamp: new Date("2026-09-10T08:01:00Z"),
      }),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_RETIRED" });
  });

  it("reopens the gate when the caller restores the identity", async () => {
    const externalId = "gmail:account:restored-message";
    await applySourceIdentityLifecycle(firstDb, {
      userId: "user_identity",
      identities: [{ type: "document", externalId }],
      action: "retire",
    });
    await applySourceIdentityLifecycle(firstDb, {
      userId: "user_identity",
      identities: [{ type: "document", externalId }],
      action: "restore",
    });
    const [retirement] = await firstDb
      .select()
      .from(sourceIdentityTombstones)
      .where(eq(sourceIdentityTombstones.externalId, externalId));
    expect(retirement).toBeUndefined();

    const minio = {
      bucketExists: vi.fn().mockResolvedValue(true),
    } as unknown as MinioClient;
    const service = new SourceService(firstDb, minio, "unused");
    await expect(
      service.insertMany([
        {
          userId: "user_identity",
          sourceType: "document",
          externalId,
          timestamp: new Date("2026-09-10T08:02:00Z"),
          content: "restored content",
        },
      ]),
    ).resolves.toMatchObject({ successes: [expect.stringMatching(/^src_/)] });
  });
  it("assigns associated and source-less legacy retirements at cutover", async () => {
    const userId = "legacy-retirement-cutover";
    const partitionKey = contextPartitionKeySchema.parse("legacy:classified");
    const unassigned = contextPartitionKeySchema.parse("legacy:unassigned");
    await firstDb.insert(users).values({ id: userId });
    await firstDb.insert(memoryPartitions).values({ userId, partitionKey });
    await firstDb.insert(sources).values({
      userId,
      type: "document",
      externalId: "associated",
      partitionKey,
      status: "completed",
    });
    await firstDb.insert(sourceIdentityTombstones).values([
      { userId, type: "document", externalId: "associated" },
      { userId, type: "document", externalId: "source-less" },
    ]);
    await setPartitionMigrationState(firstDb, {
      userId,
      expectedState: "unmigrated",
      expectedVersion: 0,
      nextState: "migrating",
    });
    await setPartitionMigrationState(firstDb, {
      userId,
      expectedState: "migrating",
      expectedVersion: 1,
      nextState: "migrated",
      unassignedPartitionKey: unassigned,
    });
    expect(
      await firstDb
        .select({
          externalId: sourceIdentityTombstones.externalId,
          partitionKey: sourceIdentityTombstones.partitionKey,
        })
        .from(sourceIdentityTombstones)
        .where(eq(sourceIdentityTombstones.userId, userId)),
    ).toEqual(
      expect.arrayContaining([
        { externalId: "associated", partitionKey },
        { externalId: "source-less", partitionKey: unassigned },
      ]),
    );
    await applySourceIdentityLifecycle(firstDb, {
      userId,
      partitionKey,
      identities: [{ type: "document", externalId: "associated" }],
      action: "restore",
    });
    await applySourceIdentityLifecycle(firstDb, {
      userId,
      partitionKey: unassigned,
      identities: [{ type: "document", externalId: "source-less" }],
      action: "restore",
    });
    expect(
      await firstDb
        .select()
        .from(sourceIdentityTombstones)
        .where(eq(sourceIdentityTombstones.userId, userId)),
    ).toEqual([]);
  });
});
