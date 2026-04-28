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
process.env["JINA_API_KEY"] ??= "test";
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

describeIfServer("open commitments query", () => {
  const dbName = `memory_open_commitments_test_${Date.now()}_${Math.floor(
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

  it("returns only active personal non-inferred open task statuses", async () => {
    const userId = "user_open_commitments";
    const ownerNodeId = newTypeId("node");
    const otherOwnerNodeId = newTypeId("node");
    const openTaskNodeId = newTypeId("node");
    const futureTaskNodeId = newTypeId("node");
    const otherOwnerTaskNodeId = newTypeId("node");
    const doneTaskNodeId = newTypeId("node");
    const referenceTaskNodeId = newTypeId("node");
    const inferredTaskNodeId = newTypeId("node");
    const soonNodeId = newTypeId("node");
    const laterNodeId = newTypeId("node");
    const personalSourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "node_metadata" (
          "id" text PRIMARY KEY NOT NULL,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "label" text,
          "canonical_label" text,
          "description" text,
          "additional_data" jsonb,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
        );
        CREATE TABLE "sources" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "type" varchar(50) NOT NULL,
          "external_id" text NOT NULL,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "status" varchar(20) DEFAULT 'completed',
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "claims" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_value" text,
          "predicate" varchar(80) NOT NULL,
          "statement" text NOT NULL,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "asserted_by_kind" varchar(24) NOT NULL,
          "stated_at" timestamp with time zone NOT NULL,
          "status" varchar(30) DEFAULT 'active' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
          VALUES
            ($1, $3, 'manual', 'manual:user_open_commitments', 'personal', 'completed'),
            ($2, $3, 'document', 'reference:user_open_commitments', 'reference', 'completed')
        `,
        [personalSourceId, referenceSourceId, userId],
      );
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
          VALUES
            ($1, $11, 'Person'),
            ($2, $11, 'Person'),
            ($3, $11, 'Task'),
            ($4, $11, 'Task'),
            ($5, $11, 'Task'),
            ($6, $11, 'Task'),
            ($7, $11, 'Task'),
            ($8, $11, 'Task'),
            ($9, $11, 'Temporal'),
            ($10, $11, 'Temporal')
        `,
        [
          ownerNodeId,
          otherOwnerNodeId,
          openTaskNodeId,
          futureTaskNodeId,
          otherOwnerTaskNodeId,
          doneTaskNodeId,
          referenceTaskNodeId,
          inferredTaskNodeId,
          soonNodeId,
          laterNodeId,
          userId,
        ],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
          VALUES
            ($1, $11, 'Marcel', 'marcel', NULL),
            ($2, $12, 'Jane', 'jane', NULL),
            ($3, $13, 'Send spec', 'send spec', NULL),
            ($4, $14, 'Review memo', 'review memo', NULL),
            ($5, $15, 'Prepare budget', 'prepare budget', NULL),
            ($6, $16, 'Done task', 'done task', NULL),
            ($7, $17, 'Reference task', 'reference task', NULL),
            ($8, $18, 'Inferred task', 'inferred task', NULL),
            ($9, $19, '2026-04-27', '2026-04-27', NULL),
            ($10, $20, '2026-05-05', '2026-05-05', NULL)
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          ownerNodeId,
          otherOwnerNodeId,
          openTaskNodeId,
          futureTaskNodeId,
          otherOwnerTaskNodeId,
          doneTaskNodeId,
          referenceTaskNodeId,
          inferredTaskNodeId,
          soonNodeId,
          laterNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id", "object_value",
            "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
          )
          VALUES
            ($1, $25, $15, NULL, 'pending', 'HAS_TASK_STATUS', 'Send spec is pending.', $23, 'personal', 'user', '2026-04-01T10:00:00Z', 'active'),
            ($2, $25, $16, NULL, 'in_progress', 'HAS_TASK_STATUS', 'Review memo is in progress.', $23, 'personal', 'user', '2026-04-02T10:00:00Z', 'active'),
            ($3, $25, $17, NULL, 'pending', 'HAS_TASK_STATUS', 'Prepare budget is pending.', $23, 'personal', 'user', '2026-04-03T10:00:00Z', 'active'),
            ($4, $25, $18, NULL, 'done', 'HAS_TASK_STATUS', 'Done task is complete.', $23, 'personal', 'user', '2026-04-04T10:00:00Z', 'active'),
            ($5, $25, $19, NULL, 'pending', 'HAS_TASK_STATUS', 'Reference task is pending.', $24, 'reference', 'document_author', '2026-04-05T10:00:00Z', 'active'),
            ($6, $25, $20, NULL, 'pending', 'HAS_TASK_STATUS', 'Inferred task is pending.', $23, 'personal', 'assistant_inferred', '2026-04-06T10:00:00Z', 'active'),
            ($7, $25, $15, $13, NULL, 'OWNED_BY', 'Marcel owns Send spec.', $23, 'personal', 'user', '2026-04-01T10:01:00Z', 'active'),
            ($8, $25, $16, $13, NULL, 'OWNED_BY', 'Marcel owns Review memo.', $23, 'personal', 'user', '2026-04-02T10:01:00Z', 'active'),
            ($9, $25, $17, $14, NULL, 'OWNED_BY', 'Jane owns Prepare budget.', $23, 'personal', 'user', '2026-04-03T10:01:00Z', 'active'),
            ($10, $25, $15, $21, NULL, 'DUE_ON', 'Send spec is due on 2026-04-27.', $23, 'personal', 'user', '2026-04-01T10:02:00Z', 'active'),
            ($11, $25, $16, $22, NULL, 'DUE_ON', 'Review memo is due on 2026-05-05.', $23, 'personal', 'user', '2026-04-02T10:02:00Z', 'active'),
            ($12, $25, $17, $21, NULL, 'DUE_ON', 'Prepare budget is due on 2026-04-27.', $23, 'personal', 'user', '2026-04-03T10:02:00Z', 'active')
        `,
        [
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          ownerNodeId,
          otherOwnerNodeId,
          openTaskNodeId,
          futureTaskNodeId,
          otherOwnerTaskNodeId,
          doneTaskNodeId,
          referenceTaskNodeId,
          inferredTaskNodeId,
          soonNodeId,
          laterNodeId,
          personalSourceId,
          referenceSourceId,
          userId,
        ],
      );
      await client.query(
        `
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id", "object_value",
            "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
          )
          VALUES
            ($1, $2, $3, NULL, 'pending', 'HAS_TASK_STATUS', 'Done task used to be pending.', $4, 'personal', 'user', '2026-04-01T09:00:00Z', 'active')
        `,
        [newTypeId("claim"), userId, doneTaskNodeId, personalSourceId],
      );
      await client.query(
        `
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id", "object_value",
            "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
          )
          VALUES
            ($1, $2, $3, $4, NULL, 'DUE_ON', 'Review memo was previously due on 2026-04-27.', $5, 'personal', 'user', '2026-04-01T10:02:00Z', 'active')
        `,
        [
          newTypeId("claim"),
          userId,
          futureTaskNodeId,
          soonNodeId,
          personalSourceId,
        ],
      );

      const { getOpenCommitments } = await import("./open-commitments");
      const commitments = await getOpenCommitments({ userId });

      expect(commitments.map((commitment) => commitment.taskId)).toEqual([
        otherOwnerTaskNodeId,
        futureTaskNodeId,
        openTaskNodeId,
      ]);
      expect(commitments[1]).toMatchObject({
        taskId: futureTaskNodeId,
        label: "Review memo",
        status: "in_progress",
        owner: { nodeId: ownerNodeId, label: "Marcel" },
        dueOn: "2026-05-05",
      });

      await expect(
        getOpenCommitments({ userId, ownedBy: ownerNodeId }),
      ).resolves.toMatchObject([
        { taskId: futureTaskNodeId },
        { taskId: openTaskNodeId },
      ]);
      await expect(
        getOpenCommitments({ userId, dueBefore: "2026-04-30" }),
      ).resolves.toMatchObject([
        { taskId: otherOwnerTaskNodeId },
        { taskId: openTaskNodeId },
      ]);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
