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
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "https://api.openai.com/v1";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test-model";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
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
  `);
}

describeIfServer("commitment curation", () => {
  const dbName = `memory_commitment_curation_test_${Date.now()}_${Math.floor(
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

  it("getCandidateCommitments returns inferred tasks (with inferred owner/due) that getOpenCommitments hides", async () => {
    const userId = "user_curation_candidate_query";
    const trustedTaskId = newTypeId("node");
    const candidateTaskId = newTypeId("node");
    const ownerNodeId = newTypeId("node");
    const dueNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'manual', 'manual:curation', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
           ($1, $5, 'Task'),
           ($2, $5, 'Task'),
           ($3, $5, 'Person'),
           ($4, $5, 'Temporal')`,
        [trustedTaskId, candidateTaskId, ownerNodeId, dueNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
           ($1, $5, 'Confirmed task', 'confirmed task'),
           ($2, $6, 'Inferred task', 'inferred task'),
           ($3, $7, 'Marcel', 'marcel'),
           ($4, $8, '2026-08-01', '2026-08-01')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          trustedTaskId,
          candidateTaskId,
          ownerNodeId,
          dueNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_node_id", "object_value",
           "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
         ) VALUES
           ($1, $9, $5, NULL, 'pending', 'HAS_TASK_STATUS', 'Confirmed task is pending.', $8, 'personal', 'user', '2026-06-01T10:00:00Z', 'active'),
           ($2, $9, $6, NULL, 'pending', 'HAS_TASK_STATUS', 'Inferred task is pending.', $8, 'personal', 'assistant_inferred', '2026-06-01T11:00:00Z', 'active'),
           ($3, $9, $6, $7, NULL, 'OWNED_BY', 'Inferred task owned by Marcel.', $8, 'personal', 'assistant_inferred', '2026-06-01T11:01:00Z', 'active'),
           ($4, $9, $6, $10, NULL, 'DUE_ON', 'Inferred task due on 2026-08-01.', $8, 'personal', 'assistant_inferred', '2026-06-01T11:02:00Z', 'active')`,
        [
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          trustedTaskId,
          candidateTaskId,
          ownerNodeId,
          sourceId,
          userId,
          dueNodeId,
        ],
      );

      const { getOpenCommitments, getCandidateCommitments } = await import(
        "./query/open-commitments"
      );

      const open = await getOpenCommitments({ userId });
      expect(open.map((c) => c.taskId)).toEqual([trustedTaskId]);

      const candidates = await getCandidateCommitments({ userId });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        taskId: candidateTaskId,
        label: "Inferred task",
        status: "pending",
        owner: { nodeId: ownerNodeId, label: "Marcel" },
        dueOn: "2026-08-01",
      });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("getCandidateCommitments surfaces a candidate's TRUSTED owner/due (e.g. user set a due date before confirming)", async () => {
    const userId = "user_curation_candidate_trusted_meta";
    const candidateTaskId = newTypeId("node");
    const ownerNodeId = newTypeId("node");
    const dueNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'manual', 'manual:trusted_meta', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
           ($1, $4, 'Task'), ($2, $4, 'Person'), ($3, $4, 'Temporal')`,
        [candidateTaskId, ownerNodeId, dueNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
           ($1, $4, 'Inferred task', 'inferred task'),
           ($2, $5, 'Marcel', 'marcel'),
           ($3, $6, '2026-09-09', '2026-09-09')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          candidateTaskId,
          ownerNodeId,
          dueNodeId,
        ],
      );
      // Inferred status (→ candidate), but TRUSTED owner + due (user-asserted).
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_node_id", "object_value",
           "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
         ) VALUES
           ($1, $6, $4, NULL, 'pending', 'HAS_TASK_STATUS', 'Inferred task is pending.', $5, 'personal', 'assistant_inferred', '2026-06-01T10:00:00Z', 'active'),
           ($2, $6, $4, $7, NULL, 'OWNED_BY', 'Marcel owns inferred task.', $5, 'personal', 'user', '2026-06-02T10:00:00Z', 'active'),
           ($3, $6, $4, $8, NULL, 'DUE_ON', 'Inferred task due on 2026-09-09.', $5, 'personal', 'user', '2026-06-02T10:01:00Z', 'active')`,
        [
          newTypeId("claim"),
          newTypeId("claim"),
          newTypeId("claim"),
          candidateTaskId,
          sourceId,
          userId,
          ownerNodeId,
          dueNodeId,
        ],
      );

      const { getCandidateCommitments } = await import(
        "./query/open-commitments"
      );

      const candidates = await getCandidateCommitments({ userId });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        taskId: candidateTaskId,
        status: "pending",
        owner: { nodeId: ownerNodeId, label: "Marcel" },
        dueOn: "2026-09-09",
      });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("assembleCandidateCommitmentsSection renders candidates and returns null when there are none", async () => {
    const userId = "user_curation_section";
    const emptyUserId = "user_curation_section_empty";
    const candidateTaskId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1), ($2)`, [
        userId,
        emptyUserId,
      ]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'manual', 'manual:section', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
        [candidateTaskId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
           VALUES ($1, $2, 'Draft the proposal', 'draft the proposal')`,
        [newTypeId("node_metadata"), candidateTaskId],
      );
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate",
           "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
         ) VALUES ($1, $2, $3, 'pending', 'HAS_TASK_STATUS',
           'Draft the proposal is pending.', $4, 'personal', 'assistant_inferred', '2026-06-01T10:00:00Z', 'active')`,
        [newTypeId("claim"), userId, candidateTaskId, sourceId],
      );

      const { assembleCandidateCommitmentsSection } = await import(
        "./context/sections/candidate-commitments"
      );

      const section = await assembleCandidateCommitmentsSection(userId);
      expect(section).not.toBeNull();
      expect(section?.kind).toBe("candidate_commitments");
      expect(section?.content).toContain("Draft the proposal");

      expect(await assembleCandidateCommitmentsSection(emptyUserId)).toBeNull();
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("confirmCommitment promotes a candidate into the open view and supersedes the inferred claim", async () => {
    const userId = "user_curation_confirm";
    const candidateTaskId = newTypeId("node");
    const sourceId = newTypeId("source");
    const inferredClaimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    // Confirm supersedes the prior HAS_TASK_STATUS (a forceRefreshOnSupersede
    // predicate), which would otherwise reach BullMQ/Redis via a dynamic
    // queues import. Stub the enqueue side-effect; the DB-level supersession is
    // still exercised and asserted below.
    vi.doMock("~/lib/jobs/atlas-invalidation", () => ({
      maybeEnqueueAtlasInvalidation: async () => false,
    }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'manual', 'manual:confirm', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
        [candidateTaskId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
           VALUES ($1, $2, 'Inferred task', 'inferred task')`,
        [newTypeId("node_metadata"), candidateTaskId],
      );
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate",
           "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
         ) VALUES ($1, $2, $3, 'pending', 'HAS_TASK_STATUS',
           'Inferred task is pending.', $4, 'personal', 'assistant_inferred', '2026-06-01T10:00:00Z', 'active')`,
        [inferredClaimId, userId, candidateTaskId, sourceId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { confirmCommitment } = await import("./commitments");
        const { getOpenCommitments, getCandidateCommitments } = await import(
          "./query/open-commitments"
        );

        const result = await confirmCommitment({
          userId,
          taskId: candidateTaskId,
        });
        expect(result).toMatchObject({
          taskId: candidateTaskId,
          status: "pending",
        });
        expect(result.claimId).toBeTruthy();

        expect(await getCandidateCommitments({ userId })).toHaveLength(0);
        const open = await getOpenCommitments({ userId });
        expect(open.map((c) => c.taskId)).toEqual([candidateTaskId]);

        const inferredRow = await client.query<{ status: string }>(
          `SELECT "status" FROM "claims" WHERE "id" = $1`,
          [inferredClaimId],
        );
        expect(inferredRow.rows[0]?.status).toBe("superseded");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/jobs/atlas-invalidation");
      vi.resetModules();
      await client.end();
    }
  });

  it("dismissCommitment retracts the inferred status so the task leaves both views", async () => {
    const userId = "user_curation_dismiss";
    const candidateTaskId = newTypeId("node");
    const sourceId = newTypeId("source");
    const inferredClaimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'manual', 'manual:dismiss', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
        [candidateTaskId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
           VALUES ($1, $2, 'Inferred task', 'inferred task')`,
        [newTypeId("node_metadata"), candidateTaskId],
      );
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate",
           "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
         ) VALUES ($1, $2, $3, 'pending', 'HAS_TASK_STATUS',
           'Inferred task is pending.', $4, 'personal', 'assistant_inferred', '2026-06-01T10:00:00Z', 'active')`,
        [inferredClaimId, userId, candidateTaskId, sourceId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { dismissCommitment } = await import("./commitments");
        const { getOpenCommitments, getCandidateCommitments } = await import(
          "./query/open-commitments"
        );

        const result = await dismissCommitment({
          userId,
          taskId: candidateTaskId,
        });
        expect(result.retractedClaimIds).toEqual([inferredClaimId]);

        expect(await getCandidateCommitments({ userId })).toHaveLength(0);
        expect(await getOpenCommitments({ userId })).toHaveLength(0);

        const row = await client.query<{ status: string }>(
          `SELECT "status" FROM "claims" WHERE "id" = $1`,
          [inferredClaimId],
        );
        expect(row.rows[0]?.status).toBe("retracted");
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
