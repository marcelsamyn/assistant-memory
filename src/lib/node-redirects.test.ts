import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId } from "~/types/typeid";
import { resolveNodeRedirects, writeNodeRedirects } from "./node-redirects";

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

describeIfServer("node redirects", () => {
  const dbName = `memory_redirects_test_${Date.now()}_${Math.floor(
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

  it("writes redirects, re-points chains, and resolves stale ids", async () => {
    const userId = "user_A";
    const survivor = newTypeId("node");
    const consumedA = newTypeId("node");
    const consumedB = newTypeId("node");
    const older = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "node_redirects" (
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "from_node_id" text NOT NULL,
          "to_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "node_redirects_user_id_from_node_id_pk"
            PRIMARY KEY ("user_id","from_node_id")
        );
      `);
      await client.query(`INSERT INTO "users" ("id") VALUES ('user_A')`);
      await client.query(
        `INSERT INTO "nodes" ("id","user_id","node_type") VALUES
          ($1,'user_A','Object'),($2,'user_A','Object'),
          ($3,'user_A','Object'),($4,'user_A','Object')`,
        [survivor, consumedA, consumedB, older],
      );

      // Pre-existing chain: older -> consumedA
      await writeNodeRedirects(database, userId, consumedA, [older]);
      // Merge consumedA + consumedB into survivor (must re-point older -> survivor)
      await writeNodeRedirects(database, userId, survivor, [
        consumedA,
        consumedB,
      ]);

      const map = await resolveNodeRedirects(database, userId, [
        consumedA,
        consumedB,
        older,
        survivor,
      ]);
      expect(map.get(consumedA)).toBe(survivor);
      expect(map.get(consumedB)).toBe(survivor);
      expect(map.get(older)).toBe(survivor); // chain re-pointed, stays flat
      expect(map.get(survivor)).toBe(survivor); // no redirect → maps to self
    } finally {
      await client.end();
    }
  });
});
