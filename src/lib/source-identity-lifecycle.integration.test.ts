import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp, toWebHandler, type EventHandler } from "h3";
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
import { insertNewSources } from "~/lib/ingestion/insert-new-sources";
import { lockSourceIdentityGates } from "~/lib/partition-access";
import { setPartitionMigrationState } from "~/lib/partition-migration";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { sourceListableTypeEnum } from "~/lib/schemas/sources";
import { applySourceIdentityLifecycle } from "~/lib/source-identity-lifecycle";
import { SourceService } from "~/lib/sources";
import {
  setSkipJobEnqueue,
  resetTestOverrides,
  setSourceServiceOverride,
} from "~/utils/test-overrides";

const queue = vi.hoisted(() => ({ add: vi.fn().mockResolvedValue(undefined) }));
vi.mock("~/lib/queues", () => ({ batchQueue: queue }));

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
  let transcriptHandler: EventHandler;

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
    vi.doMock("~/db", () => ({ default: firstDb }));
    transcriptHandler = (await import("~/routes/transcript/ingest.post"))
      .default;
  }, 120_000);

  afterAll(async () => {
    vi.doUnmock("~/db");
    vi.resetModules();
    await Promise.all([firstClient.end(), secondClient.end()]);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it.each(sourceListableTypeEnum.options)(
    "enforces retirement before inserting %s sources and parents",
    async (type) => {
      const externalId = `retired-${type}`;
      await applySourceIdentityLifecycle(firstDb, {
        userId: "user_identity",
        identities: [{ type, externalId }],
        action: "retire",
      });
      const minio = {
        bucketExists: vi.fn().mockResolvedValue(true),
      } as unknown as MinioClient;
      const service = new SourceService(firstDb, minio, "unused");
      await expect(
        service.insertMany([
          {
            userId: "user_identity",
            sourceType: type,
            externalId,
            timestamp: new Date(),
            content: "late content",
          },
        ]),
      ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_RETIRED" });
      const input = {
        db: firstDb,
        userId: "user_identity",
        parentSourceType: type,
        parentSourceId: externalId,
        childSourceType: "conversation_message" as const,
        childSources: [
          {
            externalId: `child-${type}`,
            timestamp: new Date(),
            content: "Restored child turn",
          },
        ],
      };
      await expect(insertNewSources(input)).rejects.toMatchObject({
        code: "SOURCE_IDENTITY_RETIRED",
      });
      expect(
        await firstDb
          .select()
          .from(sources)
          .where(
            and(
              eq(sources.userId, "user_identity"),
              eq(sources.type, type),
              eq(sources.externalId, externalId),
            ),
          ),
      ).toEqual([]);
      await applySourceIdentityLifecycle(firstDb, {
        userId: "user_identity",
        identities: [{ type, externalId }],
        action: "restore",
      });
      setSkipJobEnqueue(true);
      setSourceServiceOverride(service);
      try {
        await expect(insertNewSources(input)).resolves.toMatchObject({
          sourceId: expect.stringMatching(/^src_/),
        });
      } finally {
        resetTestOverrides();
      }
    },
  );

  it("rejects retired transcript intake before creation or mutation and resumes after restore", async () => {
    const externalId = "retired-transcript-intake";
    const lifecycle = {
      userId: "user_identity",
      identities: [{ type: "meeting_transcript" as const, externalId }],
    };
    const request = () =>
      toWebHandler(createApp().use(transcriptHandler))(
        new Request("http://memory.test/transcript/ingest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: "user_identity",
            transcriptId: externalId,
            occurredAt: "2026-09-10T09:00:00.000Z",
            content: { kind: "raw", text: "Private meeting content" },
          }),
        }),
      );
    const stored = () =>
      firstDb
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.userId, "user_identity"),
            eq(sources.externalId, externalId),
          ),
        );
    await applySourceIdentityLifecycle(firstDb, {
      ...lifecycle,
      action: "retire",
    });
    const denied = await request();
    expect(denied.status).toBe(409);
    await expect(denied.json()).resolves.toMatchObject({
      data: { code: "SOURCE_IDENTITY_RETIRED" },
    });
    expect(await stored()).toEqual([]);
    expect(queue.add).not.toHaveBeenCalled();
    await applySourceIdentityLifecycle(firstDb, {
      ...lifecycle,
      action: "restore",
    });
    const accepted = await request();
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    const original = await stored();
    expect(queue.add).toHaveBeenCalledExactlyOnceWith(
      "ingest-transcript",
      expect.objectContaining({
        sourceId: acceptedBody.sourceId,
        expectedSourceVersion: original[0]?.version,
      }),
    );
    await applySourceIdentityLifecycle(firstDb, {
      ...lifecycle,
      action: "retire",
    });
    expect((await request()).status).toBe(409);
    expect(await stored()).toEqual(original);
    expect(queue.add).toHaveBeenCalledTimes(1);
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
