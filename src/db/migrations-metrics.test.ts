import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = (): string =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string): string =>
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

async function applyMigration(client: Client): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const migrationsDir = path.join(process.cwd(), "drizzle");
  const migrationFiles = (await fs.readdir(migrationsDir)).filter(
    (fileName) => fileName.startsWith("0015_") && fileName.endsWith(".sql"),
  );
  if (migrationFiles.length !== 1 || migrationFiles[0] === undefined) {
    throw new Error("Expected exactly one 0015 metrics migration file.");
  }
  const migrationPath = path.join(migrationsDir, migrationFiles[0]);
  const migrationSql = await fs.readFile(migrationPath, "utf8");
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await client.query(statement);
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

describeIfServer("migration 0015 (metrics schema foundation)", () => {
  const dbName = `memory_metrics_mig_test_${Date.now()}_${Math.floor(
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

  it("supports metric rows and cascades through source and definition deletes", async () => {
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
            "created_at" timestamp with time zone DEFAULT now() NOT NULL
          );
          CREATE TABLE "sources" (
            "id" text PRIMARY KEY NOT NULL,
            "user_id" text NOT NULL REFERENCES "users"("id"),
            "type" varchar(50) NOT NULL,
            "external_id" text NOT NULL,
            "created_at" timestamp with time zone DEFAULT now() NOT NULL,
            CONSTRAINT sources_user_type_external_unique
              UNIQUE ("user_id", "type", "external_id")
          );
        `);

      await client.query("BEGIN");
      await applyMigration(client);
      await client.query("COMMIT");

      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
           WHERE table_schema='public' AND table_type='BASE TABLE'
           ORDER BY table_name`,
      );
      const tableNames = tables.rows.map((row) => row.table_name);
      expect(tableNames).toEqual(
        expect.arrayContaining([
          "metric_definitions",
          "metric_observations",
          "metric_definition_embeddings",
        ]),
      );

      const userId = `user_${crypto.randomUUID()}`;
      const definitionId = newTypeId("metric_definition");
      const sourceId = newTypeId("source");
      const observationId = newTypeId("metric_observation");
      const embeddingId = newTypeId("metric_definition_embedding");

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
           VALUES ($1, $2, 'metric_push', $3)`,
        [sourceId, userId, `oura_${crypto.randomUUID()}`],
      );
      await client.query(
        `INSERT INTO "metric_definitions"
           ("id", "user_id", "slug", "label", "description", "unit", "aggregation_hint")
           VALUES ($1, $2, 'test_resting_hr', 'Resting HR', 'Morning resting heart rate', 'bpm', 'avg')`,
        [definitionId, userId],
      );
      await client.query(
        `INSERT INTO "metric_observations"
           ("id", "user_id", "metric_definition_id", "value", "occurred_at", "source_id")
           VALUES ($1, $2, $3, '54', '2026-05-03T07:14:00Z', $4)`,
        [observationId, userId, definitionId, sourceId],
      );
      await client.query(
        `INSERT INTO "metric_definition_embeddings"
           ("id", "metric_definition_id", "embedding", "model_name")
           VALUES ($1, $2, array_fill(0.01::real, ARRAY[1024])::vector, 'test-model')`,
        [embeddingId, definitionId],
      );

      const roundTrip = await client.query<{
        slug: string;
        value: string;
        model_name: string;
      }>(
        `SELECT d.slug, o.value, e.model_name
           FROM "metric_definitions" d
           JOIN "metric_observations" o ON o.metric_definition_id = d.id
           JOIN "metric_definition_embeddings" e ON e.metric_definition_id = d.id
           WHERE d.id = $1`,
        [definitionId],
      );
      expect(roundTrip.rows).toEqual([
        {
          slug: "test_resting_hr",
          value: "54",
          model_name: "test-model",
        },
      ]);

      await client.query(`DELETE FROM "sources" WHERE "id" = $1`, [sourceId]);

      const observationsAfterSourceDelete = await client.query<{
        count: string;
      }>(
        `SELECT count(*) FROM "metric_observations"
           WHERE "metric_definition_id" = $1`,
        [definitionId],
      );
      expect(observationsAfterSourceDelete.rows[0]?.count).toBe("0");

      const definitionsAfterSourceDelete = await client.query<{
        count: string;
      }>(`SELECT count(*) FROM "metric_definitions" WHERE "id" = $1`, [
        definitionId,
      ]);
      expect(definitionsAfterSourceDelete.rows[0]?.count).toBe("1");

      await client.query(`DELETE FROM "metric_definitions" WHERE "id" = $1`, [
        definitionId,
      ]);

      const embeddingsAfterDefinitionDelete = await client.query<{
        count: string;
      }>(
        `SELECT count(*) FROM "metric_definition_embeddings"
           WHERE "metric_definition_id" = $1`,
        [definitionId],
      );
      expect(embeddingsAfterDefinitionDelete.rows[0]?.count).toBe("0");
    } finally {
      await client.end();
    }
  });
});
