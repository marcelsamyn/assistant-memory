import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

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

describeIfServer("migration 0010 (claims layer, PR 1a)", () => {
  const dbName = `memory_claims_mig_test_${Date.now()}_${Math.floor(
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

  it("cuts over edges to sourced claims, preserves source links, and is idempotent", async () => {
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);

      await client.query(`
          CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
          CREATE TABLE "nodes" (
            "id" text PRIMARY KEY NOT NULL,
            "user_id" text NOT NULL REFERENCES "users"("id"),
            "node_type" varchar(50) NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL
          );
          CREATE TABLE "node_metadata" (
            "id" text PRIMARY KEY NOT NULL,
            "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
            "label" text,
            "canonical_label" text,
            "description" text,
            "additional_data" jsonb,
            "created_at" timestamp DEFAULT now() NOT NULL,
            CONSTRAINT node_metadata_node_id_unique UNIQUE ("node_id")
          );
          CREATE TABLE "sources" (
            "id" text PRIMARY KEY NOT NULL,
            "user_id" text NOT NULL REFERENCES "users"("id"),
            "type" varchar(50) NOT NULL,
            "external_id" text NOT NULL,
            "parent_source" text,
            "metadata" jsonb,
            "last_ingested_at" timestamp,
            "status" varchar(20) DEFAULT 'pending',
            "created_at" timestamp DEFAULT now() NOT NULL,
            "deleted_at" timestamp,
            "content_type" varchar(100),
            "content_length" integer,
            CONSTRAINT sources_user_type_external_unique
              UNIQUE ("user_id", "type", "external_id")
          );
          CREATE TABLE "source_links" (
            "id" text PRIMARY KEY NOT NULL,
            "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
            "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
            "specific_location" text,
            "created_at" timestamp DEFAULT now() NOT NULL,
            CONSTRAINT source_links_source_node_unique UNIQUE ("source_id", "node_id")
          );
          CREATE TABLE "edges" (
            "id" text PRIMARY KEY NOT NULL,
            "user_id" text NOT NULL REFERENCES "users"("id"),
            "source_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
            "target_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
            "edge_type" varchar(50) NOT NULL,
            "description" text,
            "metadata" jsonb,
            "created_at" timestamp DEFAULT now() NOT NULL,
            CONSTRAINT "edges_sourceNodeId_targetNodeId_edge_type_unique"
              UNIQUE ("source_node_id", "target_node_id", "edge_type")
          );
          CREATE INDEX "edges_user_id_source_node_id_idx"
            ON "edges" ("user_id", "source_node_id");
          CREATE INDEX "edges_user_id_target_node_id_idx"
            ON "edges" ("user_id", "target_node_id");
          CREATE INDEX "edges_user_id_edge_type_idx"
            ON "edges" ("user_id", "edge_type");
          CREATE TABLE "edge_embeddings" (
            "id" text PRIMARY KEY NOT NULL,
            "edge_id" text NOT NULL REFERENCES "edges"("id") ON DELETE CASCADE,
            "embedding" vector(1024) NOT NULL,
            "model_name" varchar(100) NOT NULL,
            "created_at" timestamp DEFAULT now() NOT NULL
          );
          CREATE INDEX "edge_embeddings_embedding_idx"
            ON "edge_embeddings" USING hnsw ("embedding" vector_cosine_ops);
          CREATE INDEX "edge_embeddings_edge_id_idx"
            ON "edge_embeddings" ("edge_id");
          CREATE TABLE "aliases" (
            "id" text PRIMARY KEY NOT NULL,
            "user_id" text NOT NULL REFERENCES "users"("id"),
            "alias_text" text NOT NULL,
            "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
            "created_at" timestamp DEFAULT now() NOT NULL
          );
        `);

      await client.query(`
          INSERT INTO "users" ("id") VALUES ('user_A');
          INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at")
            VALUES
              ('node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'user_A', 'Person',       '2026-01-01T00:00:00Z'),
              ('node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'user_A', 'Object',       '2026-01-01T00:00:00Z'),
              ('node_cccccccccccccccccccccccccc', 'user_A', 'Conversation', '2026-01-01T00:00:00Z');
          INSERT INTO "node_metadata" ("id", "node_id", "label")
            VALUES
              ('nmeta_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Alice'),
              ('nmeta_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'MacBook Pro'),
              ('nmeta_cccccccccccccccccccccccccc', 'node_cccccccccccccccccccccccccc', 'Conversation');
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status", "created_at")
            VALUES ('src_realconversation________', 'user_A', 'conversation', 'conv_A', 'completed', '2026-02-01T00:00:00Z');
          INSERT INTO "source_links" ("id", "source_id", "node_id", "created_at")
            VALUES ('sln_conversation_____________', 'src_realconversation________', 'node_cccccccccccccccccccccccccc', '2026-02-01T00:00:00Z');
          INSERT INTO "edges" ("id", "user_id", "source_node_id", "target_node_id", "edge_type", "description", "created_at")
            VALUES
              ('edge_keepowned_________________', 'user_A', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'OWNED_BY',     'owns the laptop', '2026-02-01T00:00:00Z'),
              ('edge_dropmention_______________', 'user_A', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_cccccccccccccccccccccccccc', 'MENTIONED_IN', NULL,              '2026-02-02T00:00:00Z'),
              ('edge_keeptagged________________', 'user_A', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'TAGGED_WITH',  NULL,              '2026-02-03T00:00:00Z');
          INSERT INTO "edge_embeddings" ("id", "edge_id", "embedding", "model_name")
            VALUES
              ('eemb_keepowned_________________', 'edge_keepowned_________________', array_fill(0::real, ARRAY[1024])::vector, 'test-model'),
              ('eemb_dropmention_______________', 'edge_dropmention_______________', array_fill(0::real, ARRAY[1024])::vector, 'test-model');
          INSERT INTO "aliases" ("id", "user_id", "alias_text", "canonical_node_id", "created_at")
            VALUES
              ('alias_mbp______________________', 'user_A', '  MBP  ',       'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-02-01T00:00:00Z'),
              ('alias_mbp_duplicate____________', 'user_A', 'mbp',           'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-02-02T00:00:00Z'),
              ('alias_macbook__________________', 'user_A', 'MacBook Pro',   'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-02-03T00:00:00Z');
        `);

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const migrationPath = path.join(
        process.cwd(),
        "drizzle",
        "0010_claims_layer_pr_1a.sql",
      );
      const migrationSql = await fs.readFile(migrationPath, "utf8");
      const applyMigration = async () => {
        const statements = migrationSql
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter((statement) => statement.length > 0);
        for (const statement of statements) {
          await client.query(statement);
        }
      };

      await client.query("BEGIN");
      await applyMigration();
      await client.query("COMMIT");

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema='public' AND table_type='BASE TABLE'
           ORDER BY table_name`,
      );
      const tableNames = tables.rows.map((row) => row.table_name);
      expect(tableNames).toContain("claims");
      expect(tableNames).toContain("claim_embeddings");
      expect(tableNames).not.toContain("edges");
      expect(tableNames).not.toContain("edge_embeddings");

      const views = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views
           WHERE table_schema='public'
           ORDER BY table_name`,
      );
      const viewNames = views.rows.map((row) => row.table_name);
      expect(viewNames).not.toContain("edges");
      expect(viewNames).not.toContain("edge_embeddings");

      const claimsColumns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='claims'`,
      );
      const claimsColNames = claimsColumns.rows.map((row) => row.column_name);
      expect(claimsColNames).toEqual(
        expect.arrayContaining([
          "subject_node_id",
          "object_node_id",
          "object_value",
          "predicate",
          "statement",
          "source_id",
          "stated_at",
          "valid_from",
          "valid_to",
          "status",
          "updated_at",
        ]),
      );
      expect(claimsColNames).not.toContain("source_node_id");
      expect(claimsColNames).not.toContain("target_node_id");
      expect(claimsColNames).not.toContain("edge_type");

      const claimRows = await client.query<{
        id: string;
        predicate: string;
        statement: string;
        source_id: string;
        status: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, predicate, statement, source_id, status, metadata
           FROM claims
           ORDER BY created_at`,
      );
      expect(claimRows.rows).toHaveLength(2);
      expect(claimRows.rows.map((row) => row.predicate)).toEqual([
        "OWNED_BY",
        "TAGGED_WITH",
      ]);
      expect(claimRows.rows.every((row) => row.id.startsWith("claim_"))).toBe(
        true,
      );
      expect(claimRows.rows.every((row) => row.status === "active")).toBe(true);
      expect(
        claimRows.rows.every(
          (row) => row.source_id === "src_realconversation________",
        ),
      ).toBe(true);
      expect(
        claimRows.rows.every((row) => row.metadata?.["backfilled"] === true),
      ).toBe(true);
      expect(
        claimRows.rows.every((row) => row.statement.includes("Alice")),
      ).toBe(true);

      const sourceLinks = await client.query<{
        source_id: string;
        node_id: string;
      }>(`SELECT source_id, node_id FROM source_links ORDER BY node_id`);
      expect(sourceLinks.rows).toEqual(
        expect.arrayContaining([
          {
            source_id: "src_realconversation________",
            node_id: "node_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          {
            source_id: "src_realconversation________",
            node_id: "node_cccccccccccccccccccccccccc",
          },
        ]),
      );

      const legacySources = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sources WHERE type = 'legacy_migration'`,
      );
      expect(legacySources.rows[0]!.count).toBe("0");

      const embeddings = await client.query<{
        id: string;
        claim_id: string;
      }>(`SELECT id, claim_id FROM claim_embeddings ORDER BY id`);
      expect(embeddings.rows).toEqual([
        {
          id: "cemb_keepowned_________________",
          claim_id: "claim_keepowned_________________",
        },
      ]);

      const aliases = await client.query<{
        alias_text: string;
        normalized_alias_text: string;
      }>(`SELECT alias_text, normalized_alias_text FROM aliases ORDER BY id`);
      expect(aliases.rows).toHaveLength(2);
      expect(
        aliases.rows.map((row) => row.normalized_alias_text).sort(),
      ).toEqual(["macbook pro", "mbp"]);

      const indexes = await client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname='public' ORDER BY indexname`,
      );
      const indexNames = indexes.rows.map((row) => row.indexname);
      expect(indexNames).toEqual(
        expect.arrayContaining([
          "claims_user_id_subject_node_id_idx",
          "claims_user_id_object_node_id_idx",
          "claims_user_id_predicate_idx",
          "claims_user_id_status_stated_at_idx",
          "claims_user_id_subject_status_idx",
          "claims_user_id_object_status_idx",
          "claims_source_id_idx",
        ]),
      );
      expect(indexNames).not.toContain("edges_user_id_source_node_id_idx");

      await expect(
        client.query(`
            INSERT INTO claims (
              id, user_id, subject_node_id, object_node_id, object_value,
              predicate, statement, source_id, stated_at, status
            )
            VALUES (
              'claim_badboth___________________', 'user_A',
              'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb',
              'bad', 'HAS_STATUS', 'bad shape',
              'src_realconversation________', now(), 'active'
            )
          `),
      ).rejects.toThrow();

      await expect(
        client.query(`
            INSERT INTO claims (
              id, user_id, subject_node_id, predicate, statement,
              source_id, stated_at, status
            )
            VALUES (
              'claim_badneither________________', 'user_A',
              'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'HAS_STATUS', 'bad shape',
              'src_realconversation________', now(), 'active'
            )
          `),
      ).rejects.toThrow();

      await client.query("BEGIN");
      await applyMigration();
      await client.query("COMMIT");

      const rerunCounts = await client.query<{
        claims: string;
        sources: string;
        source_links: string;
        aliases: string;
        claim_embeddings: string;
      }>(
        `SELECT
            (SELECT COUNT(*)::text FROM claims) AS claims,
            (SELECT COUNT(*)::text FROM sources) AS sources,
            (SELECT COUNT(*)::text FROM source_links) AS source_links,
            (SELECT COUNT(*)::text FROM aliases) AS aliases,
            (SELECT COUNT(*)::text FROM claim_embeddings) AS claim_embeddings`,
      );
      expect(rerunCounts.rows[0]).toMatchObject({
        claims: "2",
        sources: "1",
        source_links: "2",
        aliases: "2",
        claim_embeddings: "1",
      });
    } finally {
      await client.end();
    }
  }, 30_000);
});
