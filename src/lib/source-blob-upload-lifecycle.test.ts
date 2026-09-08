import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { createServer, request as httpRequest } from "node:http";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  sourceBlobUploads,
  sourceTombstones,
  sources,
  users,
} from "~/db/schema";
import {
  applySourceLifecycleCommand,
  retryPendingSourceTombstoneStorageCleanup,
} from "~/lib/source-lifecycle";
import { sourceBlobObjectKey, SourceService } from "~/lib/sources";
import { newTypeId } from "~/types/typeid";

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
  process.env["SOURCES_BUCKET"] ??= "source-blob-upload-test";
});

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";
const MINIO_ENDPOINT = process.env["TEST_MINIO_ENDPOINT"] ?? "localhost";
const MINIO_PORT = Number(process.env["TEST_MINIO_PORT"] ?? 9000);
const MINIO_ACCESS_KEY = process.env["TEST_MINIO_ACCESS_KEY"] ?? "minio";
const MINIO_SECRET_KEY = process.env["TEST_MINIO_SECRET_KEY"] ?? "minio123";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (name: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${name}`;

async function isInfrastructureReachable(): Promise<boolean> {
  const postgres = new Client({ connectionString: adminDsn() });
  const minio = new MinioClient({
    endPoint: MINIO_ENDPOINT,
    port: MINIO_PORT,
    useSSL: false,
    accessKey: MINIO_ACCESS_KEY,
    secretKey: MINIO_SECRET_KEY,
  });
  try {
    await postgres.connect();
    await postgres.end();
    await minio.listBuckets();
    return true;
  } catch {
    return false;
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function waitForOneTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

const describeIfInfrastructure = (await isInfrastructureReachable())
  ? describe
  : describe.skip;

describeIfInfrastructure("source blob upload lifecycle coordination", () => {
  const dbName = `memory_source_blob_upload_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const bucket = `source-upload-race-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let postgres: Client;
  let lifecyclePostgres: Client;
  let database: NodePgDatabase<typeof schema>;
  let lifecycleDatabase: NodePgDatabase<typeof schema>;
  let minio: MinioClient;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    postgres = new Client({ connectionString: dsnFor(dbName) });
    await postgres.connect();
    database = drizzle(postgres, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    lifecyclePostgres = new Client({ connectionString: dsnFor(dbName) });
    await lifecyclePostgres.connect();
    lifecycleDatabase = drizzle(lifecyclePostgres, {
      schema,
      casing: "snake_case",
    });
    minio = new MinioClient({
      endPoint: MINIO_ENDPOINT,
      port: MINIO_PORT,
      useSSL: false,
      accessKey: MINIO_ACCESS_KEY,
      secretKey: MINIO_SECRET_KEY,
    });
    if (!(await minio.bucketExists(bucket))) await minio.makeBucket(bucket);
  }, 120_000);

  afterAll(async () => {
    if (await minio.bucketExists(bucket)) await minio.removeBucket(bucket);
    await lifecyclePostgres.end();
    await postgres.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("serializes a real object put with tombstone and cleans the object only after upload terminality", async () => {
    const userId = "source-upload-race-user";
    await database.insert(users).values({ id: userId });
    const enteredPut = deferred();
    const releasePut = deferred();
    const service = new SourceService(database, minio, bucket, 1, {
      beforePut: async () => {
        enteredPut.resolve();
        await releasePut.promise;
      },
    });

    const insert = service.insertMany([
      {
        userId,
        sourceType: "document",
        externalId: "blocked-real-object-put",
        timestamp: new Date(),
        fileBuffer: Buffer.from("the bytes must not survive tombstone"),
        contentType: "text/plain",
      },
    ]);
    await enteredPut.promise;
    const [source] = await lifecycleDatabase
      .select({ id: sources.id, version: sources.version })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.externalId, "blocked-real-object-put"),
        ),
      )
      .limit(1);
    if (!source) throw new Error("The pending upload source was not created");

    let tombstoneSettled = false;
    const tombstone = applySourceLifecycleCommand(lifecycleDatabase, {
      userId,
      commandId: "tombstone-blocked-put",
      sourceId: source.id,
      expectedPartitionKey: null,
      expectedSourceVersion: source.version,
      action: "tombstone",
    }).finally(() => {
      tombstoneSettled = true;
    });
    await waitForOneTurn();
    expect(tombstoneSettled).toBe(false);

    releasePut.resolve();
    await expect(tombstone).rejects.toMatchObject({
      code: "SOURCE_VERSION_CONFLICT",
    });
    await expect(insert).resolves.toEqual({
      successes: [source.id],
      failures: [],
    });
    const [completedSource] = await lifecycleDatabase
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, source.id))
      .limit(1);
    if (!completedSource) throw new Error("The completed source disappeared");
    await applySourceLifecycleCommand(lifecycleDatabase, {
      userId,
      commandId: "tombstone-after-upload-commit",
      sourceId: source.id,
      expectedPartitionKey: null,
      expectedSourceVersion: completedSource.version,
      action: "tombstone",
    });

    const [upload, tombstoneReceipt] = await Promise.all([
      lifecycleDatabase
        .select({ state: sourceBlobUploads.state })
        .from(sourceBlobUploads)
        .where(
          and(
            eq(sourceBlobUploads.userId, userId),
            eq(sourceBlobUploads.sourceId, source.id),
          ),
        )
        .limit(1),
      lifecycleDatabase
        .select({ storageCleanupState: sourceTombstones.storageCleanupState })
        .from(sourceTombstones)
        .where(
          and(
            eq(sourceTombstones.userId, userId),
            eq(sourceTombstones.sourceId, source.id),
          ),
        )
        .limit(1),
    ]);
    expect(upload[0]?.state).toBe("cleanup_pending");
    expect(tombstoneReceipt[0]?.storageCleanupState).toBe("pending");

    await expect(
      retryPendingSourceTombstoneStorageCleanup(
        lifecycleDatabase,
        (key) => service.deleteRawBlobObjectKeyIfPresent(key),
        10,
      ),
    ).resolves.toEqual({ attempted: 1, completed: 1 });
    await expect(
      minio.statObject(bucket, sourceBlobObjectKey(userId, source.id)),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/NoSuchKey|NotFound/),
    });
    const [completed] = await lifecycleDatabase
      .select({ state: sourceBlobUploads.state })
      .from(sourceBlobUploads)
      .where(
        and(
          eq(sourceBlobUploads.userId, userId),
          eq(sourceBlobUploads.sourceId, source.id),
        ),
      )
      .limit(1);
    expect(completed?.state).toBe("cleanup_completed");
  });

  it("cancels a stalled response after a real MinIO commit and leaves stale recovery to reclaim it", async () => {
    const committed = deferred();
    const proxy = createServer((request, response) => {
      const upstream = httpRequest(
        {
          hostname: MINIO_ENDPOINT,
          port: MINIO_PORT,
          method: request.method,
          path: request.url,
          headers: request.headers,
        },
        (storageResponse) => {
          if (request.method === "PUT" && storageResponse.statusCode === 200) {
            storageResponse.resume();
            storageResponse.on("end", () => committed.resolve());
          } else {
            response.writeHead(
              storageResponse.statusCode ?? 502,
              storageResponse.headers,
            );
            storageResponse.pipe(response);
          }
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("Missing proxy address");
    const proxyMinio = new MinioClient({
      endPoint: "127.0.0.1",
      port: address.port,
      useSSL: false,
      accessKey: MINIO_ACCESS_KEY,
      secretKey: MINIO_SECRET_KEY,
    });
    const userId = "source-upload-timeout-user";
    try {
      await database.insert(users).values({ id: userId });
      const service = new SourceService(
        database,
        proxyMinio,
        bucket,
        1,
        {},
        250,
      );
      const result = await service.insertMany([
        {
          userId,
          sourceType: "document",
          externalId: "timeout-after-storage-commit",
          timestamp: new Date(),
          fileBuffer: Buffer.from("committed but acknowledgement was lost"),
        },
      ]);
      await committed.promise;
      expect(result.successes).toEqual([]);
      expect(result.failures).toEqual([
        {
          sourceId: expect.any(String),
          reason: expect.stringContaining("storage outcome is unknown"),
        },
      ]);
      const [upload] = await lifecycleDatabase
        .select()
        .from(sourceBlobUploads)
        .where(eq(sourceBlobUploads.userId, userId));
      if (!upload) throw new Error("Timeout upload reservation is missing");
      expect(upload.state).toBe("uploading");
      await expect(
        minio.statObject(bucket, upload.objectKey),
      ).resolves.toBeDefined();
      const cleanupService = new SourceService(
        lifecycleDatabase,
        minio,
        bucket,
      );
      await expect(
        retryPendingSourceTombstoneStorageCleanup(
          lifecycleDatabase,
          (key) => cleanupService.deleteRawBlobObjectKeyIfPresent(key),
          10,
        ),
      ).resolves.toEqual({ attempted: 0, completed: 0 });
      await lifecycleDatabase
        .update(sourceBlobUploads)
        .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
        .where(eq(sourceBlobUploads.sourceId, upload.sourceId));
      await expect(
        retryPendingSourceTombstoneStorageCleanup(
          lifecycleDatabase,
          (key) => cleanupService.deleteRawBlobObjectKeyIfPresent(key),
          10,
        ),
      ).resolves.toEqual({ attempted: 1, completed: 1 });
      await expect(
        minio.statObject(bucket, upload.objectKey),
      ).rejects.toMatchObject({
        code: expect.stringMatching(/NoSuchKey|NotFound/),
      });
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("recovers a crash after the real object write but before descriptor commit", async () => {
    const userId = "source-upload-crash-user";
    const sourceId = newTypeId("source");
    const service = new SourceService(database, minio, bucket);
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "crashed-after-object-write",
      status: "pending",
    });
    const key = sourceBlobObjectKey(userId, sourceId);
    await new Promise<void>((resolve, reject) => {
      minio.putObject(
        bucket,
        key,
        Buffer.from("orphaned crash bytes"),
        (error) => (error ? reject(error) : resolve()),
      );
    });
    await database.insert(sourceBlobUploads).values({
      userId,
      sourceId,
      objectKey: key,
      state: "uploading",
    });
    const [source] = await lifecycleDatabase
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (!source) throw new Error("The crash-window source was not created");

    await applySourceLifecycleCommand(lifecycleDatabase, {
      userId,
      commandId: "tombstone-crash-window",
      sourceId,
      expectedPartitionKey: null,
      expectedSourceVersion: source.version,
      action: "tombstone",
    });
    await expect(
      retryPendingSourceTombstoneStorageCleanup(
        lifecycleDatabase,
        (objectKey) => service.deleteRawBlobObjectKeyIfPresent(objectKey),
        10,
      ),
    ).resolves.toEqual({ attempted: 1, completed: 1 });
    await expect(minio.statObject(bucket, key)).rejects.toMatchObject({
      code: expect.stringMatching(/NoSuchKey|NotFound/),
    });
  });

  it("reclaims an abandoned upload without requiring a tombstone", async () => {
    const userId = "source-upload-abandoned-user";
    const sourceId = newTypeId("source");
    const service = new SourceService(database, minio, bucket);
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "abandoned-upload",
      status: "pending",
    });
    const key = sourceBlobObjectKey(userId, sourceId);
    await new Promise<void>((resolve, reject) => {
      minio.putObject(bucket, key, Buffer.from("abandoned bytes"), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    await database.insert(sourceBlobUploads).values({
      userId,
      sourceId,
      objectKey: key,
      state: "uploading",
      updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });

    await expect(
      retryPendingSourceTombstoneStorageCleanup(
        lifecycleDatabase,
        (objectKey) => service.deleteRawBlobObjectKeyIfPresent(objectKey),
        10,
      ),
    ).resolves.toEqual({ attempted: 1, completed: 1 });

    const [source, upload] = await Promise.all([
      lifecycleDatabase
        .select({ status: sources.status })
        .from(sources)
        .where(eq(sources.id, sourceId))
        .limit(1),
      lifecycleDatabase
        .select({ state: sourceBlobUploads.state })
        .from(sourceBlobUploads)
        .where(eq(sourceBlobUploads.sourceId, sourceId))
        .limit(1),
    ]);
    expect(source[0]?.status).toBe("failed");
    expect(upload[0]?.state).toBe("cleanup_completed");
    await expect(minio.statObject(bucket, key)).rejects.toMatchObject({
      code: expect.stringMatching(/NoSuchKey|NotFound/),
    });
  });

  it("rejects direct and service child attachment to a tombstoned parent", async () => {
    const userId = "source-parent-liveness-user";
    const parentId = newTypeId("source");
    const childId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: parentId,
      userId,
      type: "document",
      externalId: "parent-liveness-root",
      status: "completed",
    });
    const [parent] = await database
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, parentId))
      .limit(1);
    if (!parent) throw new Error("Parent source was not created");
    await applySourceLifecycleCommand(database, {
      userId,
      sourceId: parentId,
      expectedPartitionKey: null,
      expectedSourceVersion: parent.version,
      commandId: "tombstone-parent-liveness",
      action: "tombstone",
    });

    await expect(
      database.insert(sources).values({
        id: childId,
        userId,
        type: "conversation_message",
        externalId: "direct-child-of-tombstoned-parent",
        parentSource: parentId,
        status: "completed",
      }),
    ).rejects.toThrow("source parent must be live and not tombstoned");

    const service = new SourceService(database, minio, bucket);
    await expect(
      service.insertMany([
        {
          userId,
          sourceType: "conversation_message",
          externalId: "service-child-of-tombstoned-parent",
          parentId,
          timestamp: new Date(),
          content: "must not attach",
        },
      ]),
    ).rejects.toMatchObject({ code: "SOURCE_TOMBSTONED" });
  });

  it("cannot leave a child live when attachment races parent tombstone", async () => {
    const userId = "source-parent-tombstone-race-user";
    const parentId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: parentId,
      userId,
      type: "document",
      externalId: "parent-race-root",
      status: "completed",
    });
    const [parent] = await lifecycleDatabase
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, parentId))
      .limit(1);
    if (!parent) throw new Error("Parent source was not created");

    const service = new SourceService(database, minio, bucket);
    const attachment = service.insertMany([
      {
        userId,
        sourceType: "conversation_message",
        externalId: "race-child",
        parentId,
        timestamp: new Date(),
        content: "a racing child",
      },
    ]);
    const tombstone = applySourceLifecycleCommand(lifecycleDatabase, {
      userId,
      sourceId: parentId,
      expectedPartitionKey: null,
      expectedSourceVersion: parent.version,
      commandId: "tombstone-parent-race",
      action: "tombstone",
    });
    await Promise.allSettled([attachment, tombstone]);

    const liveChildren = await lifecycleDatabase
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.parentSource, parentId),
          isNull(sources.deletedAt),
        ),
      );
    expect(liveChildren).toEqual([]);
  });

  it("takes the root child-attachment gate before its parent row lock", async () => {
    const userId = "source-parent-gate-order-user";
    const parentId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: parentId,
      userId,
      type: "document",
      externalId: "parent-gate-order-root",
      status: "completed",
    });
    const [parent] = await database
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, parentId))
      .limit(1);
    if (!parent) throw new Error("Parent source was not created");

    const gateClient = new Client({ connectionString: dsnFor(dbName) });
    const probeClient = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([gateClient.connect(), probeClient.connect()]);
    try {
      const gate = `source-parent:${userId}:${parentId}`;
      await gateClient.query("BEGIN");
      await gateClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        gate,
      ]);

      const service = new SourceService(database, minio, bucket);
      const attachment = service.insertMany(
        [
          {
            userId,
            sourceType: "conversation_message",
            externalId: "root-fenced-child",
            parentId,
            timestamp: new Date(),
            content: "a child that must wait on the gate first",
          },
        ],
        {
          userId,
          source: { sourceId: parentId, expectedSourceVersion: parent.version },
        },
      );
      const tombstone = applySourceLifecycleCommand(lifecycleDatabase, {
        userId,
        sourceId: parentId,
        expectedPartitionKey: null,
        expectedSourceVersion: parent.version,
        commandId: "tombstone-parent-gate-order",
        action: "tombstone",
      });

      await waitForOneTurn();
      await probeClient.query("BEGIN");
      try {
        // The attachment is blocked at the advisory gate. If it had already
        // locked this row, NOWAIT would expose the old inverse order here.
        await probeClient.query(
          'SELECT 1 FROM "sources" WHERE "id" = $1 FOR UPDATE NOWAIT',
          [parentId],
        );
      } finally {
        await probeClient.query("COMMIT");
      }

      await gateClient.query("COMMIT");
      const settled = await Promise.allSettled([attachment, tombstone]);
      expect(
        settled.filter(
          (result) =>
            result.status === "rejected" &&
            typeof result.reason === "object" &&
            result.reason !== null &&
            "code" in result.reason &&
            result.reason.code === "40P01",
        ),
      ).toEqual([]);
    } finally {
      await gateClient.query("ROLLBACK").catch(() => undefined);
      await Promise.all([gateClient.end(), probeClient.end()]);
    }

    const liveChildren = await lifecycleDatabase
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.parentSource, parentId),
          isNull(sources.deletedAt),
        ),
      );
    expect(liveChildren).toEqual([]);
  });

  it("serializes direct SQL reparenting with parent tombstone", async () => {
    const userId = "source-direct-reparent-gate-user";
    const parentId = newTypeId("source");
    const childId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: parentId,
        userId,
        type: "document",
        externalId: "direct-reparent-parent",
        status: "completed",
      },
      {
        id: childId,
        userId,
        type: "conversation_message",
        externalId: "direct-reparent-child",
        status: "completed",
      },
    ]);
    const [parent] = await database
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, parentId))
      .limit(1);
    if (!parent) throw new Error("Parent source was not created");

    const gateClient = new Client({ connectionString: dsnFor(dbName) });
    const directClient = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([gateClient.connect(), directClient.connect()]);
    try {
      const gate = `source-parent:${userId}:${parentId}`;
      await gateClient.query("BEGIN");
      await gateClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        gate,
      ]);
      let directSettled = false;
      const directReparent = directClient
        .query("BEGIN")
        .then(() =>
          directClient.query(
            'UPDATE "sources" SET "parent_source" = $1 WHERE "id" = $2',
            [parentId, childId],
          ),
        )
        .then(() => directClient.query("COMMIT"))
        .finally(() => {
          directSettled = true;
        });
      await waitForOneTurn();
      expect(directSettled).toBe(false);

      const tombstone = applySourceLifecycleCommand(lifecycleDatabase, {
        userId,
        sourceId: parentId,
        expectedPartitionKey: null,
        expectedSourceVersion: parent.version,
        commandId: "tombstone-direct-reparent-parent",
        action: "tombstone",
      });
      await gateClient.query("COMMIT");
      const [directResult, tombstoneResult] = await Promise.allSettled([
        directReparent,
        tombstone,
      ]);
      expect(directResult.status).toBe("fulfilled");
      expect(
        tombstoneResult.status === "rejected" &&
          typeof tombstoneResult.reason === "object" &&
          tombstoneResult.reason !== null &&
          "code" in tombstoneResult.reason
          ? tombstoneResult.reason.code
          : undefined,
      ).not.toBe("40P01");
    } finally {
      await gateClient.query("ROLLBACK").catch(() => undefined);
      await directClient.query("ROLLBACK").catch(() => undefined);
      await Promise.all([gateClient.end(), directClient.end()]);
    }

    const liveChildren = await lifecycleDatabase
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.parentSource, parentId),
          isNull(sources.deletedAt),
        ),
      );
    expect(liveChildren).toEqual([]);
  });
});
