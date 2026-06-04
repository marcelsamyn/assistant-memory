import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { createCommitmentRequestSchema } from "~/lib/schemas/create-commitment";
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

/**
 * Provision the minimal table set `createCommitment` exercises end-to-end:
 * `createNode` (nodes/metadata/sources/source_links + today's day node),
 * `createClaim` + lifecycle (claims), and the `getOpenCommitments` read model.
 * Embedding tables are intentionally omitted — the test flips on the
 * skip-embedding-persistence seam so no embedding rows are written.
 */
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

describeIfServer("createCommitment", () => {
  const dbName = `memory_create_commitment_test_${Date.now()}_${Math.floor(
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

  it("opens a pending commitment that surfaces in the open-commitments view", async () => {
    const userId = "user_create_commitment_min";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment } = await import("./commitments");
        const { getOpenCommitments } = await import("./query/open-commitments");

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Send the spec",
          }),
        );

        expect(created).toMatchObject({
          label: "Send the spec",
          status: "pending",
          dueOn: null,
          owner: null,
          dueClaimId: null,
          ownerClaimId: null,
        });
        expect(created.taskId).toBeTruthy();
        expect(created.statusClaimId).toBeTruthy();

        const commitments = await getOpenCommitments({ userId });
        expect(commitments).toHaveLength(1);
        expect(commitments[0]).toMatchObject({
          taskId: created.taskId,
          label: "Send the spec",
          status: "pending",
          owner: null,
          dueOn: null,
        });
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("opens an in_progress commitment with a due date and owner", async () => {
    const userId = "user_create_commitment_full";
    const ownerNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [ownerNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
           VALUES ($1, $2, 'Marcel', 'marcel')`,
        [newTypeId("node_metadata"), ownerNodeId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment } = await import("./commitments");
        const { getOpenCommitments } = await import("./query/open-commitments");

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Review the memo",
            status: "in_progress",
            dueOn: "2026-07-15",
            ownedBy: ownerNodeId,
          }),
        );

        expect(created).toMatchObject({
          label: "Review the memo",
          status: "in_progress",
          dueOn: "2026-07-15",
          owner: { nodeId: ownerNodeId, label: "Marcel" },
        });
        expect(created.dueClaimId).toBeTruthy();
        expect(created.ownerClaimId).toBeTruthy();

        const commitments = await getOpenCommitments({ userId });
        expect(commitments).toHaveLength(1);
        expect(commitments[0]).toMatchObject({
          taskId: created.taskId,
          label: "Review the memo",
          status: "in_progress",
          owner: { nodeId: ownerNodeId, label: "Marcel" },
          dueOn: "2026-07-15",
        });
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
