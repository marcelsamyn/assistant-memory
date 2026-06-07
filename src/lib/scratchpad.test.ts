import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

process.env["DATABASE_URL"] ??= adminDsn();

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
 * Provision just the tables the scratchpad write path touches: `users` and the
 * `scratchpads` table with its FK back to `users` (the constraint that fired
 * for a brand-new user whose first action was a scratchpad write).
 */
async function provisionSchema(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "scratchpads" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "content" text DEFAULT '' NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "scratchpads_user_id_unique" UNIQUE ("user_id")
    );
  `);
}

describeIfServer("writeScratchpad", () => {
  const dbName = `memory_scratchpad_test_${Date.now()}_${Math.floor(
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

  it("creates the user on a brand-new user's first write", async () => {
    // The user row does not exist yet — this mirrors the new-user flow where
    // the very first assistant action is a scratchpad write.
    const userId = "user_scratchpad_first_write";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/db", () => ({ default: database }));

    try {
      await provisionSchema(client);

      const { writeScratchpad, readScratchpad } = await import("./scratchpad");

      const written = await writeScratchpad({
        userId,
        content: "remember the milk",
        mode: "overwrite",
      });
      expect(written.content).toBe("remember the milk");

      // The user row was created as a side effect, so the FK held.
      const users = await client.query(
        `SELECT "id" FROM "users" WHERE "id" = $1`,
        [userId],
      );
      expect(users.rows).toHaveLength(1);

      const read = await readScratchpad({ userId });
      expect(read.content).toBe("remember the milk");
    } finally {
      vi.doUnmock("~/db");
      vi.resetModules();
      await client.end();
    }
  });
});
