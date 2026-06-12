import { ensureDayNode, ensurePeriodNode } from "./temporal";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  resetTestOverrides,
  setSkipEmbeddingPersistence,
} from "~/utils/test-overrides";

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

describeIfServer("ensurePeriodNode", () => {
  const dbName = `memory_temporal_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;

  beforeAll(async () => {
    setSkipEmbeddingPersistence(true);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
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
    `);
    await client.query(`INSERT INTO "users" ("id") VALUES ('user_t')`);
  });

  afterAll(async () => {
    resetTestOverrides();
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

  it("creates a Temporal node per period key and is idempotent", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });

    const weekId = await ensurePeriodNode(db, "user_t", "2026-W24");
    const weekIdAgain = await ensurePeriodNode(db, "user_t", "2026-W24");
    expect(weekIdAgain).toBe(weekId);

    const monthId = await ensurePeriodNode(db, "user_t", "2026-06");
    const yearId = await ensurePeriodNode(db, "user_t", "2026");
    expect(new Set([weekId, monthId, yearId]).size).toBe(3);

    const rows = await client.query(
      `SELECT m."label", m."description", n."node_type"
       FROM "node_metadata" m JOIN "nodes" n ON n."id" = m."node_id"
       WHERE n."user_id" = 'user_t' ORDER BY m."label"`,
    );
    expect(rows.rows).toEqual([
      {
        label: "2026",
        description: "Represents the year 2026",
        node_type: "Temporal",
      },
      {
        label: "2026-06",
        description: "Represents the month 2026-06",
        node_type: "Temporal",
      },
      {
        label: "2026-W24",
        description: "Represents the week 2026-W24",
        node_type: "Temporal",
      },
    ]);
  });

  it("ensureDayNode delegates and stays label-compatible", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const viaDate = await ensureDayNode(db, "user_t", new Date(2026, 5, 8));
    const viaKey = await ensurePeriodNode(db, "user_t", "2026-06-08");
    expect(viaKey).toBe(viaDate);
  });

  it("rejects malformed period keys", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    await expect(ensurePeriodNode(db, "user_t", "junk")).rejects.toThrow();
  });
});
