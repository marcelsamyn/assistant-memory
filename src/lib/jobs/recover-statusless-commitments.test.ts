/**
 * DB-integration tests for `recoverStatuslessCommitments`.
 *
 * The sweep repairs the Task⟺status invariant: a Task with no HAS_TASK_STATUS
 * claim in any lifecycle state gets a default candidate-band status so it
 * surfaces as a candidate. Deliberately-dismissed tasks (status retracted) and
 * tasks that already have a status must be left untouched.
 */
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

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

process.env["DATABASE_URL"] ??= adminDsn();
process.env["JINA_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "https://api.openai.com/v1";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test-model";
process.env["REDIS_URL"] ??= "redis://localhost:6380";

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

async function provisionSchema(client: Client): Promise<void> {
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
      CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
    );
    CREATE TABLE IF NOT EXISTS "sources" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "type" varchar(50) NOT NULL,
      "external_id" text NOT NULL,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "status" varchar(20) DEFAULT 'completed',
      "parent_source" text,
      "metadata" jsonb,
      "last_ingested_at" timestamp with time zone,
      "deleted_at" timestamp with time zone,
      "content_type" varchar(100),
      "content_length" integer,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "sources_user_type_external_unique"
        UNIQUE ("user_id", "type", "external_id")
    );
    CREATE TABLE IF NOT EXISTS "source_links" (
      "id" text PRIMARY KEY NOT NULL,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "specific_location" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
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
      "object_instant" timestamp with time zone,
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
    CREATE TABLE IF NOT EXISTS "aliases" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "alias_text" text NOT NULL,
      "normalized_alias_text" text NOT NULL,
      "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "aliases_user_normalized_canonical_unique"
        UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
    );
  `);
}

async function seedTask(
  client: Client,
  args: { id: TypeId<"node">; userId: string; label: string },
): Promise<void> {
  await client.query(
    `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
    [args.id, args.userId],
  );
  await client.query(
    `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
     VALUES ($1, $2, $3, lower($3))`,
    [newTypeId("node_metadata"), args.id, args.label],
  );
}

async function seedStatusClaim(
  client: Client,
  args: {
    userId: string;
    taskId: TypeId<"node">;
    sourceId: TypeId<"source">;
    status: "active" | "retracted";
    assertedByKind: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "claims" (
       "id", "user_id", "subject_node_id", "object_value", "predicate",
       "statement", "source_id", "scope", "asserted_by_kind", "status", "stated_at"
     ) VALUES ($1, $2, $3, 'pending', 'HAS_TASK_STATUS', 'Task status.', $4,
               'personal', $5, $6, now())`,
    [
      newTypeId("claim"),
      args.userId,
      args.taskId,
      args.sourceId,
      args.assertedByKind,
      args.status,
    ],
  );
}

describeIfServer("recoverStatuslessCommitments", () => {
  const dbName = `memory_recover_statusless_test_${Date.now()}_${Math.floor(
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

  /**
   * Seed three tasks: a statusless one (birth defect), a dismissed one
   * (retracted status), and an open one (active trusted status), plus a source
   * for the seeded claims. Returns their ids.
   */
  async function seedFixture(
    client: Client,
    userId: string,
  ): Promise<{
    statuslessTask: TypeId<"node">;
    dismissedTask: TypeId<"node">;
    openTask: TypeId<"node">;
  }> {
    const statuslessTask = newTypeId("node");
    const dismissedTask = newTypeId("node");
    const openTask = newTypeId("node");
    const sourceId = newTypeId("source");

    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
    await seedTask(client, {
      id: statuslessTask,
      userId,
      label: "Call plumber",
    });
    await seedTask(client, { id: dismissedTask, userId, label: "Old idea" });
    await seedTask(client, { id: openTask, userId, label: "Ship the PR" });
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
       VALUES ($1, $2, 'manual', $3)`,
      [sourceId, userId, `manual:${sourceId}`],
    );
    // Dismissed = a retracted status in history (must be skipped).
    await seedStatusClaim(client, {
      userId,
      taskId: dismissedTask,
      sourceId,
      status: "retracted",
      assertedByKind: "assistant_inferred",
    });
    // Open = an active trusted status (already a commitment).
    await seedStatusClaim(client, {
      userId,
      taskId: openTask,
      sourceId,
      status: "active",
      assertedByKind: "user",
    });

    return { statuslessTask, dismissedTask, openTask };
  }

  it("dry run finds only the statusless task and writes nothing", async () => {
    const userId = "user_recover_dryrun";
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      const { statuslessTask } = await seedFixture(client, userId);

      const { recoverStatuslessCommitments } = await import(
        "./recover-statusless-commitments"
      );
      const result = await recoverStatuslessCommitments({ userId });

      expect(result.dryRun).toBe(true);
      expect(result.candidateCount).toBe(1);
      expect(result.recoveredCount).toBe(0);
      expect(result.hasMore).toBe(false);
      expect(result.candidates.map((task) => task.id)).toEqual([
        statuslessTask,
      ]);

      // No status claims were created (only the two seeded ones remain).
      const statusCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM "claims"
         WHERE "user_id" = $1 AND "predicate" = 'HAS_TASK_STATUS'`,
        [userId],
      );
      expect(statusCount.rows[0]?.count).toBe("2");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("apply recovers the statusless task into the candidate band and leaves dismissed/open tasks untouched", async () => {
    const userId = "user_recover_apply";
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { statuslessTask, dismissedTask, openTask } = await seedFixture(
          client,
          userId,
        );

        const { recoverStatuslessCommitments } = await import(
          "./recover-statusless-commitments"
        );
        const result = await recoverStatuslessCommitments({
          userId,
          dryRun: false,
        });

        expect(result.recoveredCount).toBe(1);
        expect(result.candidateCount).toBe(1);

        // The recovered task now carries one active pending/assistant_inferred
        // status claim.
        const recovered = await client.query<{
          object_value: string;
          asserted_by_kind: string;
          status: string;
        }>(
          `SELECT "object_value", "asserted_by_kind", "status" FROM "claims"
           WHERE "user_id" = $1 AND "subject_node_id" = $2
             AND "predicate" = 'HAS_TASK_STATUS' AND "status" = 'active'`,
          [userId, statuslessTask],
        );
        expect(recovered.rows).toEqual([
          {
            object_value: "pending",
            asserted_by_kind: "assistant_inferred",
            status: "active",
          },
        ]);

        // It surfaces as a candidate; the open task is still a trusted
        // commitment; the dismissed task is in neither view.
        const { getOpenCommitments, getCandidateCommitments } = await import(
          "../query/open-commitments"
        );
        const candidates = await getCandidateCommitments({ userId });
        expect(candidates.map((c) => c.taskId)).toEqual([statuslessTask]);

        const open = await getOpenCommitments({ userId });
        expect(open.map((c) => c.taskId)).toEqual([openTask]);

        // The dismissed task still has no active status — not resurrected.
        const dismissedActive = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM "claims"
           WHERE "user_id" = $1 AND "subject_node_id" = $2
             AND "predicate" = 'HAS_TASK_STATUS' AND "status" = 'active'`,
          [userId, dismissedTask],
        );
        expect(dismissedActive.rows[0]?.count).toBe("0");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
