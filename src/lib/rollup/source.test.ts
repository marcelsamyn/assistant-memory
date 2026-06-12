import { ensureRollupSource } from "./source";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";

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

describeIfServer("ensureRollupSource", () => {
  const dbName = `memory_rollup_source_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(`
      CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
      CREATE TABLE "sources" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "type" varchar(50) NOT NULL,
        "external_id" text NOT NULL,
        "parent_source" text,
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
    await client.query(`INSERT INTO "users" ("id") VALUES ('user_rollup')`);
  });

  afterAll(async () => {
    await client.end();
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

  it("creates the source once and returns the same id thereafter", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });

    const first = await ensureRollupSource(db, "user_rollup");
    const second = await ensureRollupSource(db, "user_rollup");
    expect(second).toBe(first);

    const rows = await client.query(
      `SELECT "type", "external_id", "status" FROM "sources" WHERE "user_id" = 'user_rollup'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      type: "rollup",
      external_id: "rollup",
      status: "completed",
    });
  });
});
