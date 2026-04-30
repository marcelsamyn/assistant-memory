/**
 * DB-integration tests for the placeholder-Person cleanup-surfacing job.
 *
 * Covers age/scope/user filters, candidate matching by canonical label,
 * and the thin queue-seeding helper.
 */
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

process.env["DATABASE_URL"] ??= adminDsn();
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test-model";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

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

async function createTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
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
      UNIQUE ("node_id")
    );
  `);
}

interface SeedNodeArgs {
  userId: string;
  nodeId: string;
  label: string;
  canonicalLabel: string;
  unresolvedSpeaker?: boolean;
  /** Override the `created_at` timestamp. */
  createdAt?: Date;
  nodeType?: string;
}

async function seedPersonNode(
  client: Client,
  {
    userId,
    nodeId,
    label,
    canonicalLabel,
    unresolvedSpeaker = false,
    createdAt,
    nodeType = "Person",
  }: SeedNodeArgs,
): Promise<void> {
  if (createdAt) {
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at") VALUES ($1, $2, $3, $4)`,
      [nodeId, userId, nodeType, createdAt],
    );
  } else {
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, $3)`,
      [nodeId, userId, nodeType],
    );
  }
  const additional = unresolvedSpeaker
    ? `'{"unresolvedSpeaker": true}'::jsonb`
    : `NULL`;
  await client.query(
    `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "additional_data")
     VALUES ($1, $2, $3, $4, ${additional})`,
    [newTypeId("node_metadata"), nodeId, label, canonicalLabel],
  );
}

describeIfServer("cleanupPlaceholders", () => {
  const dbName = `memory_cleanup_placeholders_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

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

  async function withDb<T>(
    fn: (client: Client, database: ReturnType<typeof drizzle>) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      const database = drizzle(client, { schema, casing: "snake_case" });
      await createTables(client);
      return await fn(client, database);
    } finally {
      await client.end();
    }
  }

  function applyDbMock(database: ReturnType<typeof drizzle>) {
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    // The cleanup-placeholders module imports `../queues` at top-level,
    // which connects to Redis on load. Stub it so unit tests don't need a
    // running Redis server.
    vi.doMock("../queues", () => ({
      batchQueue: { add: async () => ({ id: "noop" }) },
    }));
  }

  function unmockDb() {
    vi.doUnmock("~/utils/db");
    vi.doUnmock("../queues");
    vi.resetModules();
  }

  it("surfaces aged placeholder Persons and matches same-label candidates", async () => {
    await withDb(async (client, database) => {
      const userId = "user_placeholder_a";
      const oldPlaceholderId = newTypeId("node");
      const candidateId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      // 10 days ago — older than the default 7-day threshold.
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

      await seedPersonNode(client, {
        userId,
        nodeId: oldPlaceholderId,
        label: "Alex",
        canonicalLabel: "alex",
        unresolvedSpeaker: true,
        createdAt: tenDaysAgo,
      });
      await seedPersonNode(client, {
        userId,
        nodeId: candidateId,
        label: "Alex Johnson",
        canonicalLabel: "alex",
      });

      applyDbMock(database);
      try {
        const { cleanupPlaceholders } = await import("./cleanup-placeholders");
        const result = await cleanupPlaceholders({ userId });

        expect(result.placeholders).toHaveLength(1);
        expect(result.placeholders[0]?.id).toBe(oldPlaceholderId);
        expect(result.placeholders[0]?.label).toBe("Alex");
        expect(result.placeholders[0]?.candidates).toHaveLength(1);
        expect(result.placeholders[0]?.candidates[0]?.id).toBe(candidateId);
      } finally {
        unmockDb();
      }
    });
  });

  it("does not surface placeholders younger than the cutoff", async () => {
    await withDb(async (client, database) => {
      const userId = "user_placeholder_fresh";
      const freshId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await seedPersonNode(client, {
        userId,
        nodeId: freshId,
        label: "Sam",
        canonicalLabel: "sam",
        unresolvedSpeaker: true,
        // default created_at = now()
      });

      applyDbMock(database);
      try {
        const { cleanupPlaceholders } = await import("./cleanup-placeholders");
        const result = await cleanupPlaceholders({
          userId,
          olderThanDays: 7,
        });
        expect(result.placeholders).toEqual([]);
      } finally {
        unmockDb();
      }
    });
  });

  it("does not surface non-placeholder Persons", async () => {
    await withDb(async (client, database) => {
      const userId = "user_placeholder_nonph";
      const realPersonId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await seedPersonNode(client, {
        userId,
        nodeId: realPersonId,
        label: "Marie",
        canonicalLabel: "marie",
        unresolvedSpeaker: false,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      applyDbMock(database);
      try {
        const { cleanupPlaceholders } = await import("./cleanup-placeholders");
        const result = await cleanupPlaceholders({ userId });
        expect(result.placeholders).toEqual([]);
      } finally {
        unmockDb();
      }
    });
  });

  it("does not surface placeholders for a different user", async () => {
    await withDb(async (client, database) => {
      const userId = "user_placeholder_isolation_a";
      const otherUserId = "user_placeholder_isolation_b";
      const otherPlaceholderId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1), ($2)`, [
        userId,
        otherUserId,
      ]);
      await seedPersonNode(client, {
        userId: otherUserId,
        nodeId: otherPlaceholderId,
        label: "Other",
        canonicalLabel: "other",
        unresolvedSpeaker: true,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      applyDbMock(database);
      try {
        const { cleanupPlaceholders } = await import("./cleanup-placeholders");
        const result = await cleanupPlaceholders({ userId });
        expect(result.placeholders).toEqual([]);
      } finally {
        unmockDb();
      }
    });
  });

  it("returns empty candidate list when no labels match", async () => {
    await withDb(async (client, database) => {
      const userId = "user_placeholder_no_match";
      const placeholderId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await seedPersonNode(client, {
        userId,
        nodeId: placeholderId,
        label: "Speaker_3",
        canonicalLabel: "speaker_3",
        unresolvedSpeaker: true,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      applyDbMock(database);
      try {
        const { cleanupPlaceholders } = await import("./cleanup-placeholders");
        const result = await cleanupPlaceholders({ userId });
        expect(result.placeholders).toHaveLength(1);
        expect(result.placeholders[0]?.candidates).toEqual([]);
      } finally {
        unmockDb();
      }
    });
  });

  it("seedClaimsCleanupForPlaceholders enqueues a cleanup-graph job with the placeholder ids", async () => {
    await withDb(async (client, database) => {
      const userId = "user_placeholder_seed";
      const placeholderId = newTypeId("node");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await seedPersonNode(client, {
        userId,
        nodeId: placeholderId,
        label: "Alex",
        canonicalLabel: "alex",
        unresolvedSpeaker: true,
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      });

      const addCalls: Array<{ name: string; data: unknown }> = [];
      vi.resetModules();
      vi.doMock("~/utils/db", () => ({
        useDatabase: async () => database,
      }));
      vi.doMock("../queues", () => ({
        batchQueue: {
          add: async (name: string, data: unknown) => {
            addCalls.push({ name, data });
            return { id: "test_job_id" };
          },
        },
      }));
      try {
        const { cleanupPlaceholders, seedClaimsCleanupForPlaceholders } =
          await import("./cleanup-placeholders");

        const result = await cleanupPlaceholders({ userId });
        expect(result.placeholders).toHaveLength(1);

        const seeded = await seedClaimsCleanupForPlaceholders(
          { userId, olderThanDays: 7, limit: 50 },
          result,
        );

        expect(seeded?.jobId).toBe("test_job_id");
        expect(seeded?.seedIds).toEqual([placeholderId]);
        expect(addCalls).toHaveLength(1);
        expect(addCalls[0]?.name).toBe("cleanup-graph");
        const data = addCalls[0]?.data as {
          userId: string;
          seedIds: string[];
          llmModelId: string;
          since: string;
        };
        expect(data.userId).toBe(userId);
        expect(data.seedIds).toEqual([placeholderId]);
        expect(typeof data.llmModelId).toBe("string");
        expect(data.llmModelId.length).toBeGreaterThan(0);
        // `since` is included so the cleanup pipeline scopes ambient seed
        // harvesting to the same window as the placeholder age cutoff.
        expect(typeof data.since).toBe("string");
      } finally {
        unmockDb();
      }
    });
  });
});
