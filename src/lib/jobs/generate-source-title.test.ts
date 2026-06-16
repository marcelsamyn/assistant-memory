import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { sources } from "~/db/schema";
import { eq } from "drizzle-orm";
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
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
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

describeIfServer("generateSourceTitle", () => {
  const dbName = `memory_source_title_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  let pgClient: Client;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    pgClient = new Client({ connectionString: dsnFor(dbName) });
    await pgClient.connect();
    await createSourceTitleTables(pgClient);

    db = drizzle(pgClient, { schema, casing: "snake_case" });
  });

  afterAll(async () => {
    await pgClient.end();
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

  async function createSourceTitleTables(client: Client): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
      CREATE TABLE IF NOT EXISTS "sources" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "type" varchar(50) NOT NULL,
        "external_id" text NOT NULL,
        "parent_source" text REFERENCES "sources"("id"),
        "scope" varchar(16) DEFAULT 'personal' NOT NULL,
        "metadata" jsonb,
        "last_ingested_at" timestamp with time zone,
        "status" varchar(20) DEFAULT 'pending',
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "deleted_at" timestamp with time zone,
        "content_type" varchar(100),
        "content_length" integer,
        CONSTRAINT "sources_user_type_external_unique"
          UNIQUE ("user_id", "type", "external_id")
      );
    `);
  }

  it("generates and stores a title for an untitled conversation", async () => {
    const userId = "user_title_test";
    await pgClient.query(`INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);

    const parentId = newTypeId("source");
    const childId = newTypeId("source");

    await pgClient.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES ($1, $2, 'conversation', 'conv-1', 'personal')`,
      [parentId, userId],
    );
    await pgClient.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "parent_source", "metadata") VALUES ($1, $2, 'conversation_message', 'msg-1', 'personal', $3, $4)`,
      [childId, userId, parentId, JSON.stringify({ rawContent: "Let's plan the Q3 offsite in Lisbon" })],
    );

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => db,
    }));

    // MinIO is not available, so mock sourceService.fetchRaw to return nothing
    // (simulating no blob for a container source, falling back to child rawContent)
    vi.doMock("~/lib/sources", async (importOriginal) => {
      const mod = await importOriginal<typeof import("~/lib/sources")>();
      return {
        ...mod,
        sourceService: {
          ...mod.sourceService,
          fetchRaw: async () => [],
        },
      };
    });

    try {
      // Set the extraction override AFTER resetModules so it lands in the fresh
      // module graph that generateSourceTitle will see.
      const { setExtractionClientOverride } = await import("~/utils/test-overrides");
      setExtractionClientOverride({
        chat: {
          completions: {
            parse: async () => ({
              choices: [{ message: { parsed: { title: "Q3 offsite planning" } } }],
              usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
            }),
          },
        },
      } as never);

      const { generateSourceTitle } = await import("./generate-source-title");
      const result = await generateSourceTitle(db, { userId, sourceId: parentId });

      expect(result.generated).toBe(true);

      const [row] = await db
        .select({ metadata: sources.metadata })
        .from(sources)
        .where(eq(sources.id, parentId));
      expect((row!.metadata as { title?: string }).title).toBe(
        "Q3 offsite planning",
      );
    } finally {
      const { setExtractionClientOverride: clear } = await import("~/utils/test-overrides");
      clear(null);
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/sources");
      vi.resetModules();
    }
  });

  it("is a no-op when the source already has a title", async () => {
    const userId = "user_title_noop_test";
    await pgClient.query(`INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);

    const sourceId = newTypeId("source");
    await pgClient.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "metadata") VALUES ($1, $2, 'conversation', 'conv-noop', 'personal', $3)`,
      [sourceId, userId, JSON.stringify({ title: "Existing title" })],
    );

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => db,
    }));

    try {
      const { generateSourceTitle } = await import("./generate-source-title");
      const result = await generateSourceTitle(db, { userId, sourceId });
      expect(result.generated).toBe(false);

      // Title should remain unchanged
      const [row] = await db
        .select({ metadata: sources.metadata })
        .from(sources)
        .where(eq(sources.id, sourceId));
      expect((row!.metadata as { title?: string }).title).toBe("Existing title");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
    }
  });
});
