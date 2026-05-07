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

describeIfServer("ensureSpineNodes / linkSpineToDocument", () => {
  const dbName = `memory_spine_test_${Date.now()}_${Math.floor(
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

  it("inserts new Concept nodes for unmatched spine concepts and reuses existing ones via canonical label", async () => {
    const userId = "user_spine";
    const sourceId = newTypeId("source");
    const existingConceptNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await createTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      // A Concept node already exists for "Self-Publishing on Amazon" — the
      // spine pre-pass should reuse it instead of inserting a duplicate.
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Concept')`,
        [existingConceptNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
         VALUES ($1, $2, $3, $4, $5)`,
        [
          newTypeId("node_metadata"),
          existingConceptNodeId,
          "Self-Publishing on Amazon",
          "self-publishing on amazon",
          "Pre-existing description.",
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'document', 'doc_spine', 'personal', 'completed')`,
        [sourceId, userId],
      );

      const { ensureSpineNodes } = await import("./ensure-spine-nodes");

      const result = await ensureSpineNodes({
        userId,
        sourceId,
        spine: {
          thesis: "Authors can self-publish on Amazon to reach bestseller.",
          spineConcepts: [
            {
              label: "Self-Publishing on Amazon",
              description: "Different description from the new pass.",
            },
            {
              label: "Author Platform Building",
              description: "Building an author's online platform.",
            },
          ],
        },
      });

      expect(result).toHaveLength(2);

      // First concept reused the existing node.
      expect(result[0]?.nodeId).toBe(existingConceptNodeId);
      // Second concept is new — should have been inserted.
      expect(result[1]?.nodeId).not.toBe(existingConceptNodeId);

      // Reused node keeps its existing description, new node uses the
      // pre-pass description.
      expect(result[0]?.description).toBe("Pre-existing description.");
      expect(result[1]?.description).toBe(
        "Building an author's online platform.",
      );

      // Both concepts must be sourceLinked to the document source so they
      // appear in "nodes for this document" listings.
      const linkRows = await client.query<{
        node_id: string;
        source_id: string;
      }>(
        `SELECT "node_id", "source_id" FROM "source_links" WHERE "source_id" = $1 ORDER BY "node_id"`,
        [sourceId],
      );
      const linkedNodeIds = new Set(linkRows.rows.map((r) => r.node_id));
      expect(linkedNodeIds.has(result[0]!.nodeId)).toBe(true);
      expect(linkedNodeIds.has(result[1]!.nodeId)).toBe(true);

      // Exactly one new Concept node was inserted (the reused one was
      // already there).
      const conceptCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM "nodes" WHERE "user_id" = $1 AND "node_type" = 'Concept'`,
        [userId],
      );
      expect(conceptCount.rows[0]?.count).toBe("2");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("inserts a RELATED_TO claim from each spine node to the document node", async () => {
    const userId = "user_spine_link";
    const sourceId = newTypeId("source");
    const documentNodeId = newTypeId("node");
    const spineNodeA = newTypeId("node");
    const spineNodeB = newTypeId("node");
    const statedAt = new Date("2026-05-07T12:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await createTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $4, 'Document'),
          ($2, $4, 'Concept'),
          ($3, $4, 'Concept')`,
        [documentNodeId, spineNodeA, spineNodeB, userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'document', 'doc_link', 'personal', 'completed')`,
        [sourceId, userId],
      );

      const { linkSpineToDocument } = await import("./ensure-spine-nodes");

      await linkSpineToDocument({
        userId,
        sourceId,
        documentNodeId,
        statedAt,
        spineNodes: [
          {
            nodeId: spineNodeA,
            label: "Self-Publishing on Amazon",
            description: null,
          },
          {
            nodeId: spineNodeB,
            label: "Author Platform Building",
            description: null,
          },
        ],
        documentLabel: "Self Publishing Strategy Guide",
      });

      const claimRows = await client.query<{
        subject_node_id: string;
        object_node_id: string;
        predicate: string;
        asserted_by_kind: string;
        statement: string;
      }>(
        `SELECT "subject_node_id", "object_node_id", "predicate", "asserted_by_kind", "statement"
         FROM "claims" WHERE "user_id" = $1 ORDER BY "subject_node_id"`,
        [userId],
      );

      expect(claimRows.rows).toHaveLength(2);
      for (const row of claimRows.rows) {
        expect(row.predicate).toBe("RELATED_TO");
        expect(row.asserted_by_kind).toBe("document_author");
        expect(row.object_node_id).toBe(documentNodeId);
        expect(row.statement).toContain("Self Publishing Strategy Guide");
      }
      const subjectIds = claimRows.rows.map((r) => r.subject_node_id).sort();
      expect(subjectIds).toEqual([spineNodeA, spineNodeB].sort());
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
