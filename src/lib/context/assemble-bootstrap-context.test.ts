import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId, type TypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

process.env["DATABASE_URL"] ??= `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

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

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

async function createBundleTestTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "content" text NOT NULL,
      "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "nodes" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "node_type" varchar(50) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "node_metadata" (
      "id" text PRIMARY KEY NOT NULL,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "label" text,
      "canonical_label" text,
      "description" text,
      "additional_data" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
    );
    CREATE TABLE IF NOT EXISTS "sources" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "type" varchar(50) NOT NULL,
      "external_id" text NOT NULL,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "status" varchar(20) DEFAULT 'completed',
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "sources_user_type_external_unique"
        UNIQUE ("user_id", "type", "external_id")
    );
    CREATE TABLE IF NOT EXISTS "claims" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
      "object_value" text,
      "predicate" varchar(80) NOT NULL,
      "statement" text NOT NULL,
      "description" text,
      "metadata" jsonb,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "asserted_by_kind" varchar(24) NOT NULL,
      "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
      "superseded_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
      "contradicted_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
      "stated_at" timestamp with time zone NOT NULL,
      "valid_from" timestamp with time zone,
      "valid_to" timestamp with time zone,
      "status" varchar(30) DEFAULT 'active' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "claims_object_shape_xor_ck"
        CHECK (num_nonnulls("object_node_id", "object_value") = 1)
    );
  `);
}

interface FakeRedis {
  store: Map<string, string>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode?: string,
    ttl?: number,
  ): Promise<"OK">;
  del(key: string): Promise<number>;
}

function createFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK" as const;
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

describeIfServer("getConversationBootstrapContext", () => {
  const dbName = `memory_context_bundle_test_${Date.now().toString()}_${Math.floor(Math.random() * 1e6).toString()}`;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  type TestDb = ReturnType<typeof makeTestDb>;
  function makeTestDb(client: Client) {
    return drizzle(client, { schema, casing: "snake_case" });
  }

  async function withFreshSchema<T>(
    fn: (client: Client, db: TestDb) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = makeTestDb(client);
    try {
      // Clear any rows left over from a prior test in this describe block.
      await client.query(
        `DROP TABLE IF EXISTS "claims", "node_metadata", "nodes", "sources", "user_profiles", "users" CASCADE`,
      );
      await createBundleTestTables(client);
      return await fn(client, database);
    } finally {
      await client.end();
    }
  }

  /**
   * Seed a user with an Atlas node + description, pinned content, two open
   * tasks, one recent HAS_STATUS supersession, and three preferences. Used
   * by the happy-path test.
   */
  async function seedFullUser(
    client: Client,
    database: TestDb,
    userId: string,
  ): Promise<{
    sourceId: TypeId<"source">;
    taskAId: TypeId<"node">;
    taskBId: TypeId<"node">;
    statusSubjectId: TypeId<"node">;
  }> {
    const sourceId = newTypeId("source");
    const personId = newTypeId("node");
    const atlasId = newTypeId("node");
    const taskAId = newTypeId("node");
    const taskBId = newTypeId("node");
    const statusSubjectId = newTypeId("node");

    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
    await client.query(
      `INSERT INTO "user_profiles" ("id", "user_id", "content")
         VALUES ($1, $2, $3)`,
      [newTypeId("user_profile"), userId, "Pinned: speak plainly."],
    );
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'conversation_message', 'msg_full', 'personal', 'completed')`,
      [sourceId, userId],
    );
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
        ($1, $6, 'Person'),
        ($2, $6, 'Atlas'),
        ($3, $6, 'Task'),
        ($4, $6, 'Task'),
        ($5, $6, 'Object')`,
      [personId, atlasId, taskAId, taskBId, statusSubjectId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "description") VALUES
        ($1, $6, 'Marcel', NULL),
        ($2, $7, 'Atlas', $11),
        ($3, $8, 'Write the spec', NULL),
        ($4, $9, 'Send the budget', NULL),
        ($5, $10, 'Claims Layer', NULL)`,
      [
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        personId,
        atlasId,
        taskAId,
        taskBId,
        statusSubjectId,
        "Marcel ships things.",
      ],
    );

    await database.insert(schema.claims).values([
      // Open commitments — two pending tasks.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskAId,
        objectValue: "pending",
        predicate: "HAS_TASK_STATUS",
        statement: "Task A is pending.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-26T10:00:00.000Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskBId,
        objectValue: "in_progress",
        predicate: "HAS_TASK_STATUS",
        statement: "Task B is in progress.",
        sourceId,
        scope: "personal",
        assertedByKind: "user_confirmed",
        statedAt: new Date("2026-04-27T10:00:00.000Z"),
        status: "active",
      },
      // Recent supersession — a HAS_STATUS that just transitioned, within window.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: statusSubjectId,
        objectValue: "in_progress",
        predicate: "HAS_STATUS",
        statement: "Claims Layer was in progress.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-27T09:00:00.000Z"),
        status: "superseded",
      },
      // Preferences — three trusted personal claims.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "concise communication",
        predicate: "HAS_PREFERENCE",
        statement: "Marcel prefers concise communication.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-25T10:00:00.000Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "deep work in mornings",
        predicate: "HAS_PREFERENCE",
        statement: "Marcel prefers deep work in mornings.",
        sourceId,
        scope: "personal",
        assertedByKind: "user_confirmed",
        statedAt: new Date("2026-04-26T10:00:00.000Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "ship the claims layer",
        predicate: "HAS_GOAL",
        statement: "Marcel will ship the claims layer.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-22T10:00:00.000Z"),
        status: "active",
      },
    ]);

    return { sourceId, taskAId, taskBId, statusSubjectId };
  }

  it("happy path: composes all five sections in design order with content + evidence", async () => {
    await withFreshSchema(async (client, database) => {
      const userId = "user_full";
      await seedFullUser(client, database, userId);

      const fakeRedis = createFakeRedis();
      vi.resetModules();
      vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
      vi.doMock("../queues", () => ({ redisConnection: fakeRedis }));

      try {
        const { getConversationBootstrapContext } = await import(
          "./assemble-bootstrap-context"
        );
        const bundle = await getConversationBootstrapContext({ userId });

        expect(bundle.sections.map((s) => s.kind)).toEqual([
          "pinned",
          "atlas",
          "open_commitments",
          "recent_supersessions",
          "preferences",
        ]);

        const pinned = bundle.sections[0];
        expect(pinned?.kind).toBe("pinned");
        expect(pinned?.content).toContain("speak plainly");

        const atlas = bundle.sections[1];
        expect(atlas?.kind).toBe("atlas");
        expect(atlas?.content).toContain("Marcel ships things");

        const open = bundle.sections[2];
        expect(open?.kind).toBe("open_commitments");
        expect(open?.content).toContain("Write the spec");
        expect(open?.content).toContain("[pending]");
        expect(open?.content).toContain("Send the budget");
        expect(open?.content).toContain("[in_progress]");

        const recent = bundle.sections[3];
        expect(recent?.kind).toBe("recent_supersessions");
        expect(recent?.content).toContain("Claims Layer");
        expect(recent?.content).toContain("[superseded]");
        expect(recent?.evidence).toBeDefined();
        expect(recent?.evidence?.length).toBeGreaterThan(0);

        const prefs = bundle.sections[4];
        expect(prefs?.kind).toBe("preferences");
        expect(prefs?.content).toContain("HAS_PREFERENCE=concise communication");
        expect(prefs?.content).toContain("HAS_PREFERENCE=deep work in mornings");
        expect(prefs?.content).toContain("HAS_GOAL=ship the claims layer");
        expect(prefs?.evidence?.length).toBe(3);
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("../queues");
        vi.resetModules();
      }
    });
  });

  it("skips empty sections: pinned + open_commitments only when atlas/preferences/supersessions are absent", async () => {
    await withFreshSchema(async (client, database) => {
      const userId = "user_sparse";
      const sourceId = newTypeId("source");
      const taskId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "user_profiles" ("id", "user_id", "content")
           VALUES ($1, $2, 'Pinned only.')`,
        [newTypeId("user_profile"), userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'conversation_message', 'msg_sparse', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
        [taskId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES ($1, $2, 'Sparse Task')`,
        [newTypeId("node_metadata"), taskId],
      );
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: taskId,
          objectValue: "pending",
          predicate: "HAS_TASK_STATUS",
          statement: "Sparse task pending.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-27T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const fakeRedis = createFakeRedis();
      vi.resetModules();
      vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
      vi.doMock("../queues", () => ({ redisConnection: fakeRedis }));

      try {
        const { getConversationBootstrapContext } = await import(
          "./assemble-bootstrap-context"
        );
        const bundle = await getConversationBootstrapContext({ userId });
        expect(bundle.sections.map((s) => s.kind)).toEqual([
          "pinned",
          "open_commitments",
        ]);
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("../queues");
        vi.resetModules();
      }
    });
  });

  it("cache hit: second call does not re-query the DB", async () => {
    await withFreshSchema(async (client, database) => {
      const userId = "user_cache";
      const sourceId = newTypeId("source");
      const taskId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'conversation_message', 'msg_cache', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
        [taskId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES ($1, $2, 'CacheTask')`,
        [newTypeId("node_metadata"), taskId],
      );
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: taskId,
          objectValue: "pending",
          predicate: "HAS_TASK_STATUS",
          statement: "Cache task pending.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-27T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const fakeRedis = createFakeRedis();
      let openCommitmentsCalls = 0;

      vi.resetModules();
      vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
      vi.doMock("../queues", () => ({ redisConnection: fakeRedis }));
      // Spy on the underlying cheap section query — wrap the real impl so we
      // confirm zero calls on the cached read.
      const realModule = await import("../query/open-commitments");
      vi.doMock("../query/open-commitments", () => ({
        getOpenCommitments: async (
          ...args: Parameters<typeof realModule.getOpenCommitments>
        ) => {
          openCommitmentsCalls += 1;
          return realModule.getOpenCommitments(...args);
        },
      }));

      try {
        const { getConversationBootstrapContext } = await import(
          "./assemble-bootstrap-context"
        );
        const first = await getConversationBootstrapContext({ userId });
        expect(openCommitmentsCalls).toBe(1);
        expect(first.sections.length).toBeGreaterThan(0);

        const second = await getConversationBootstrapContext({ userId });
        expect(openCommitmentsCalls).toBe(1);
        expect(second.sections.length).toBe(first.sections.length);
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("../queues");
        vi.doUnmock("../query/open-commitments");
        vi.resetModules();
      }
    });
  });

  it("invalidation: a HAS_STATUS supersession via the existing hook drops the cached bundle", async () => {
    await withFreshSchema(async (client, database) => {
      const userId = "user_invalidate";
      const sourceId = newTypeId("source");
      const subjectId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'conversation_message', 'msg_inv', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Object')`,
        [subjectId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES ($1, $2, 'InvSubject')`,
        [newTypeId("node_metadata"), subjectId],
      );
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: subjectId,
          objectValue: "in_progress",
          predicate: "HAS_STATUS",
          statement: "InvSubject in progress.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: subjectId,
          objectValue: "done",
          predicate: "HAS_STATUS",
          statement: "InvSubject done.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-27T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const fakeRedis = createFakeRedis();
      vi.resetModules();
      vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
      vi.doMock("../queues", () => ({
        redisConnection: fakeRedis,
        // Stub batchQueue.add so the atlas-user enqueue inside
        // maybeEnqueueAtlasInvalidation doesn't reach into a real worker.
        batchQueue: { add: async () => undefined },
      }));

      try {
        // Prime the cache via a direct write through `setCachedBundle`.
        const { setCachedBundle, getCachedBundle } = await import("./cache");
        await setCachedBundle(userId, {
          sections: [
            {
              kind: "pinned",
              content: "primed",
              usage: "primed",
            },
          ],
          assembledAt: new Date(),
        });
        expect(await getCachedBundle(userId)).not.toBeNull();

        // Drive supersession + the invalidation hook.
        const { applyClaimLifecycle } = await import("../claims/lifecycle");
        const since = new Date(Date.now() - 60_000);
        const inserted = await database.select().from(schema.claims);
        await applyClaimLifecycle(database, inserted);

        const { maybeEnqueueAtlasInvalidation } = await import(
          "../jobs/atlas-invalidation"
        );
        const triggered = await maybeEnqueueAtlasInvalidation(
          database,
          userId,
          since,
        );
        expect(triggered).toBe(true);

        expect(await getCachedBundle(userId)).toBeNull();
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("../queues");
        vi.resetModules();
      }
    });
  });

  it("recent supersessions window: 25h-old excluded, 1h-old included", async () => {
    await withFreshSchema(async (client, database) => {
      const userId = "user_window";
      const sourceId = newTypeId("source");
      const subjectId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'conversation_message', 'msg_win', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Object')`,
        [subjectId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES ($1, $2, 'WinSubject')`,
        [newTypeId("node_metadata"), subjectId],
      );

      const asOf = new Date("2026-04-28T12:00:00.000Z");
      const oldUpdated = new Date(asOf.getTime() - 25 * 60 * 60 * 1000);
      const recentUpdated = new Date(asOf.getTime() - 1 * 60 * 60 * 1000);

      const oldId = newTypeId("claim");
      const recentId = newTypeId("claim");
      await database.insert(schema.claims).values([
        {
          id: oldId,
          userId,
          subjectNodeId: subjectId,
          objectValue: "old_value",
          predicate: "HAS_STATUS",
          statement: "Outside window.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: oldUpdated,
          status: "superseded",
        },
        {
          id: recentId,
          userId,
          subjectNodeId: subjectId,
          objectValue: "fresh_value",
          predicate: "HAS_STATUS",
          statement: "Inside window.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: recentUpdated,
          status: "superseded",
        },
      ]);
      // Force updated_at to match — drizzle defaultNow on insert puts everything at "now."
      await client.query(
        `UPDATE "claims" SET "updated_at" = $1 WHERE "id" = $2`,
        [oldUpdated, oldId],
      );
      await client.query(
        `UPDATE "claims" SET "updated_at" = $1 WHERE "id" = $2`,
        [recentUpdated, recentId],
      );

      const fakeRedis = createFakeRedis();
      vi.resetModules();
      vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
      vi.doMock("../queues", () => ({ redisConnection: fakeRedis }));

      try {
        const { getConversationBootstrapContext } = await import(
          "./assemble-bootstrap-context"
        );
        const bundle = await getConversationBootstrapContext({
          userId,
          options: { asOf },
        });
        const recent = bundle.sections.find(
          (s) => s.kind === "recent_supersessions",
        );
        expect(recent).toBeDefined();
        expect(recent?.content).toContain("Inside window.");
        expect(recent?.content).not.toContain("Outside window.");
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("../queues");
        vi.resetModules();
      }
    });
  });

  it("preferences trust filter: assistant_inferred excluded; user/user_confirmed included", async () => {
    await withFreshSchema(async (client, database) => {
      const userId = "user_trust";
      const sourceId = newTypeId("source");
      const personId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'conversation_message', 'msg_trust', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [personId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES ($1, $2, 'Marcel')`,
        [newTypeId("node_metadata"), personId],
      );

      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personId,
          objectValue: "trusted_user_pref",
          predicate: "HAS_PREFERENCE",
          statement: "user-stated preference.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-27T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personId,
          objectValue: "trusted_confirmed_pref",
          predicate: "HAS_PREFERENCE",
          statement: "user-confirmed preference.",
          sourceId,
          scope: "personal",
          assertedByKind: "user_confirmed",
          statedAt: new Date("2026-04-26T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personId,
          objectValue: "INFERRED_PREF_LEAK",
          predicate: "HAS_PREFERENCE",
          statement: "assistant-inferred preference.",
          sourceId,
          scope: "personal",
          assertedByKind: "assistant_inferred",
          statedAt: new Date("2026-04-25T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const fakeRedis = createFakeRedis();
      vi.resetModules();
      vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
      vi.doMock("../queues", () => ({ redisConnection: fakeRedis }));

      try {
        const { getConversationBootstrapContext } = await import(
          "./assemble-bootstrap-context"
        );
        const bundle = await getConversationBootstrapContext({ userId });
        const prefs = bundle.sections.find((s) => s.kind === "preferences");
        expect(prefs).toBeDefined();
        expect(prefs?.content).toContain("trusted_user_pref");
        expect(prefs?.content).toContain("trusted_confirmed_pref");
        expect(prefs?.content).not.toContain("INFERRED_PREF_LEAK");
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("../queues");
        vi.resetModules();
      }
    });
  });
});
