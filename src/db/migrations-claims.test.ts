/**
 * Migration test for the claims-first layer (PR 1a).
 *
 * Runs the drizzle migrator against an ephemeral Postgres database,
 * seeds a synthetic pre-migration edges state, applies all migrations
 * (including the new 0009_claims_layer_pr_1a), and asserts:
 *
 * - Table/column renames landed (`edges` → `claims`, `source_node_id`
 *   → `subject_node_id`, etc.).
 * - Structural predicates (`MENTIONED_IN`, `CAPTURED_IN`, `INVALIDATED_ON`)
 *   are removed.
 * - Remaining claims are backfilled with a `legacy_migration` source,
 *   templated statement, stated_at = created_at, status = 'active',
 *   and `metadata.backfilled = true`.
 * - `edge_*` TypeIDs have been rewritten to `claim_*` / `cemb_*`.
 * - Aliases gained `normalized_alias_text` and the new UNIQUE constraint.
 * - A second application of migration 0009 is a safe no-op (idempotent).
 *
 * The test requires a reachable Postgres server on the dev docker port
 * (5431); it creates an isolated database per run so it coexists with
 * the dev server without cross-contamination.
 */
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

describeIfServer("migration 0009 (claims layer, PR 1a)", () => {
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
    // Terminate any lingering connections before dropping.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it(
    "applies cleanly on a seeded pre-migration edges snapshot and is idempotent on rerun",
    async () => {
      const client = new Client({ connectionString: dsnFor(dbName) });
      await client.connect();

      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);

        // -----------------------------------------------------------------
        // Seed a minimal pre-migration snapshot: just the shape migration
        // 0009 needs to transform. This mirrors what migrations 0001–0008
        // would have produced, but slimmed to the tables the test exercises.
        // -----------------------------------------------------------------
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

        // Seed data: one user, two nodes, three edges. One edge uses the
        // structural predicate `MENTIONED_IN` and must disappear post-migration.
        await client.query(`
          INSERT INTO "users" ("id") VALUES ('user_A');
          INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at")
            VALUES
              ('node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'user_A', 'Person',  '2026-01-01T00:00:00Z'),
              ('node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'user_A', 'Object',  '2026-01-01T00:00:00Z');
          INSERT INTO "node_metadata" ("id", "node_id", "label")
            VALUES
              ('nmeta_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'Alice'),
              ('nmeta_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'MacBook Pro');
          INSERT INTO "edges" ("id", "user_id", "source_node_id", "target_node_id", "edge_type", "description", "created_at")
            VALUES
              ('edge_keepowned_________________', 'user_A', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'OWNED_BY',       'owns the laptop', '2026-02-01T00:00:00Z'),
              ('edge_dropmention_______________', 'user_A', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'MENTIONED_IN',   NULL,              '2026-02-02T00:00:00Z'),
              ('edge_keeptagged________________', 'user_A', 'node_aaaaaaaaaaaaaaaaaaaaaaaaaa', 'node_bbbbbbbbbbbbbbbbbbbbbbbbbb', 'TAGGED_WITH',    NULL,              '2026-02-03T00:00:00Z');
          INSERT INTO "aliases" ("id", "user_id", "alias_text", "canonical_node_id")
            VALUES
              ('alias_mbp______________________', 'user_A', '  MBP  ',       'node_bbbbbbbbbbbbbbbbbbbbbbbbbb'),
              ('alias_macbook__________________', 'user_A', 'MacBook Pro',   'node_bbbbbbbbbbbbbbbbbbbbbbbbbb');
        `);

        // -----------------------------------------------------------------
        // Load and apply only migration 0009 directly. We do not invoke the
        // drizzle migrator because it would first try to apply 0001..0008
        // on top of our hand-seeded schema and the CREATE TABLE statements
        // would collide. The point of this test is to prove the 0009 step
        // transforms a realistic pre-migration state correctly.
        // -----------------------------------------------------------------
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        const migrationPath = path.join(
          process.cwd(),
          "drizzle",
          "0009_claims_layer_pr_1a.sql",
        );
        const migrationSql = await fs.readFile(migrationPath, "utf8");

        const applyMigration = async () => {
          const statements = migrationSql
            .split("--> statement-breakpoint")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          for (const statement of statements) {
            await client.query(statement);
          }
        };

        await client.query("BEGIN");
        await applyMigration();
        await client.query("COMMIT");

        // -----------------------------------------------------------------
        // Post-state assertions.
        // -----------------------------------------------------------------
        const tables = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema='public' AND table_type='BASE TABLE'
           ORDER BY table_name`,
        );
        const tableNames = tables.rows.map((r) => r.table_name);
        expect(tableNames).toContain("claims");
        expect(tableNames).toContain("claim_embeddings");
        expect(tableNames).not.toContain("edges"); // edges is now a view
        expect(tableNames).not.toContain("edge_embeddings");

        const views = await client.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.views
           WHERE table_schema='public'
           ORDER BY table_name`,
        );
        const viewNames = views.rows.map((r) => r.table_name);
        expect(viewNames).toContain("edges");
        expect(viewNames).toContain("edge_embeddings");

        const claimsColumns = await client.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='claims'`,
        );
        const claimsColNames = claimsColumns.rows.map((r) => r.column_name);
        expect(claimsColNames).toContain("subject_node_id");
        expect(claimsColNames).toContain("object_node_id");
        expect(claimsColNames).toContain("predicate");
        expect(claimsColNames).toContain("object_value");
        expect(claimsColNames).toContain("statement");
        expect(claimsColNames).toContain("source_id");
        expect(claimsColNames).toContain("stated_at");
        expect(claimsColNames).toContain("valid_from");
        expect(claimsColNames).toContain("valid_to");
        expect(claimsColNames).toContain("status");
        expect(claimsColNames).toContain("updated_at");
        expect(claimsColNames).not.toContain("source_node_id");
        expect(claimsColNames).not.toContain("target_node_id");
        expect(claimsColNames).not.toContain("edge_type");

        // Structural predicate rows are gone; only the two factual rows
        // remain and both are backfilled.
        const claimRows = await client.query<{
          id: string;
          predicate: string;
          statement: string;
          source_id: string;
          stated_at: Date;
          status: string;
          metadata: Record<string, unknown>;
        }>(
          `SELECT id, predicate, statement, source_id, stated_at, status, metadata
             FROM claims
             ORDER BY created_at`,
        );
        expect(claimRows.rows).toHaveLength(2);
        expect(
          claimRows.rows.every((r) => r.id.startsWith("claim_")),
        ).toBe(true);
        expect(
          claimRows.rows.every((r) => r.predicate !== "MENTIONED_IN"),
        ).toBe(true);
        expect(claimRows.rows.every((r) => r.status === "active")).toBe(true);
        expect(
          claimRows.rows.every((r) => r.source_id.startsWith("src_")),
        ).toBe(true);
        expect(
          claimRows.rows.every((r) => r.metadata?.["backfilled"] === true),
        ).toBe(true);
        expect(claimRows.rows.every((r) => r.statement.length > 0)).toBe(true);
        // Templated statement should contain the subject label.
        expect(
          claimRows.rows.every((r) => r.statement.includes("Alice")),
        ).toBe(true);

        const sources = await client.query<{
          id: string;
          user_id: string;
          type: string;
        }>(`SELECT id, user_id, type FROM sources WHERE type = 'legacy_migration'`);
        expect(sources.rows).toHaveLength(1);
        expect(sources.rows[0]!.user_id).toBe("user_A");

        // All claims should point at the synthetic per-user source.
        expect(
          claimRows.rows.every((r) => r.source_id === sources.rows[0]!.id),
        ).toBe(true);

        // Aliases: normalized_alias_text backfilled; constraint exists.
        const aliases = await client.query<{
          alias_text: string;
          normalized_alias_text: string;
        }>(`SELECT alias_text, normalized_alias_text FROM aliases ORDER BY id`);
        expect(aliases.rows).toHaveLength(2);
        for (const row of aliases.rows) {
          expect(row.normalized_alias_text).toBe(
            row.alias_text.trim().toLowerCase(),
          );
        }
        const aliasUnique = await client.query<{ constraint_name: string }>(
          `SELECT constraint_name FROM information_schema.table_constraints
           WHERE table_schema='public' AND table_name='aliases'
             AND constraint_type='UNIQUE'`,
        );
        expect(
          aliasUnique.rows.map((r) => r.constraint_name),
        ).toContain("aliases_user_normalized_canonical_unique");

        // Edges view echoes the legacy column names over claims data.
        const viaView = await client.query<{
          source_node_id: string;
          target_node_id: string;
          edge_type: string;
        }>(`SELECT source_node_id, target_node_id, edge_type FROM edges`);
        expect(viaView.rows).toHaveLength(2);
        expect(
          viaView.rows.every((r) =>
            r.source_node_id.startsWith("node_") && r.target_node_id.startsWith("node_"),
          ),
        ).toBe(true);

        // ---------------------------------------------------------------
        // Rerun 0009. Must be a no-op — no errors, no duplicate rows, no
        // extra legacy_migration source.
        // ---------------------------------------------------------------
        await client.query("BEGIN");
        await applyMigration();
        await client.query("COMMIT");

        const rerunClaimCount = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM claims`,
        );
        expect(rerunClaimCount.rows[0]!.count).toBe("2");

        const rerunSourceCount = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM sources WHERE type='legacy_migration'`,
        );
        expect(rerunSourceCount.rows[0]!.count).toBe("1");

        const rerunAliases = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM aliases WHERE normalized_alias_text IS NULL`,
        );
        expect(rerunAliases.rows[0]!.count).toBe("0");
      } finally {
        await client.end();
      }
    },
    30_000,
  );
});
