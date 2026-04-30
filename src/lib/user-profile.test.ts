/**
 * DB-integration tests for `getUserSelfAliases` / `setUserSelfAliases`.
 *
 * Mirrors `cleanup-operations.test.ts`: real Postgres on the non-default
 * test port, hand-rolled DDL (no migrator). The migration idempotence
 * test re-applies `0013_user_profiles_metadata.sql` on a migrated DB and
 * asserts no-op shape.
 */
import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  getUserSelfAliases,
  setUserSelfAliases,
} from "~/lib/user-profile";

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

type TestDb = NodePgDatabase<typeof schema>;

async function createTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "content" text NOT NULL,
      "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
      "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

describeIfServer("user-profile self-aliases helpers", () => {
  const dbName = `memory_user_profile_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  let database: TestDb;
  let rootClient: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    rootClient = new Client({ connectionString: dsnFor(dbName) });
    await rootClient.connect();
    database = drizzle(rootClient, { schema, casing: "snake_case" });
    await createTables(rootClient);
  });

  afterAll(async () => {
    await rootClient.end();

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

  afterEach(async () => {
    await rootClient.query(`TRUNCATE "user_profiles", "users" CASCADE`);
  });

  async function seedUser(userId: string): Promise<void> {
    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  }

  it("setUserSelfAliases creates user_profiles row when none exists", async () => {
    const userId = "user_create";
    await seedUser(userId);

    const result = await setUserSelfAliases(database, userId, [
      "Marcel",
      "MS",
    ]);
    expect(result.aliases).toEqual(["Marcel", "MS"]);

    const rows = await rootClient.query<{
      content: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT "content", "metadata" FROM "user_profiles" WHERE "user_id" = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.content).toBe("");
    expect(rows.rows[0]?.metadata).toMatchObject({
      userSelfAliases: ["Marcel", "MS"],
    });
  });

  it("setUserSelfAliases updates only userSelfAliases, preserving other catchall metadata", async () => {
    const userId = "user_preserve";
    await seedUser(userId);

    // Seed an existing row that already carries an unrelated catchall key.
    await rootClient.query(
      `INSERT INTO "user_profiles" ("id", "user_id", "content", "metadata")
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "user_profile_preserve_____",
        userId,
        "existing pinned content",
        JSON.stringify({
          userSelfAliases: ["old"],
          otherFlag: { keep: true },
        }),
      ],
    );

    const result = await setUserSelfAliases(database, userId, [
      "Marcel",
      "marcel@samyn.co",
    ]);
    expect(result.aliases).toEqual(["Marcel", "marcel@samyn.co"]);

    const rows = await rootClient.query<{
      content: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT "content", "metadata" FROM "user_profiles" WHERE "user_id" = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.content).toBe("existing pinned content");
    expect(rows.rows[0]?.metadata).toMatchObject({
      userSelfAliases: ["Marcel", "marcel@samyn.co"],
      otherFlag: { keep: true },
    });
  });

  it("getUserSelfAliases returns [] when no row exists", async () => {
    const userId = "user_missing";
    await seedUser(userId);
    expect(await getUserSelfAliases(database, userId)).toEqual([]);
  });

  it("getUserSelfAliases parses persisted aliases", async () => {
    const userId = "user_persisted";
    await seedUser(userId);
    await setUserSelfAliases(database, userId, ["Marcel", "MS"]);
    expect(await getUserSelfAliases(database, userId)).toEqual([
      "Marcel",
      "MS",
    ]);
  });

  it("setUserSelfAliases rejects empty strings inside the array", async () => {
    const userId = "user_empty";
    await seedUser(userId);
    await expect(
      setUserSelfAliases(database, userId, ["Marcel", ""]),
    ).rejects.toThrow();
  });
});

describeIfServer("migration 0013 (user_profiles.metadata) idempotence", () => {
  const dbName = `memory_user_profile_mig_test_${Date.now()}_${Math.floor(
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

  it("adds metadata column once and is a no-op on rerun", async () => {
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      // Pre-migration shape: user_profiles WITHOUT `metadata`.
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "user_profiles" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "content" text NOT NULL,
          "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ('user_mig')`,
      );
      await client.query(
        `INSERT INTO "user_profiles" ("id", "user_id", "content")
         VALUES ('user_profile_premig________', 'user_mig', 'existing content')`,
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const migrationSql = await fs.readFile(
        path.join(
          process.cwd(),
          "drizzle",
          "0013_user_profiles_metadata.sql",
        ),
        "utf8",
      );
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

      // Pre-existing row defaulted to '{}'::jsonb.
      const afterFirst = await client.query<{
        content: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT "content", "metadata" FROM "user_profiles"
           WHERE "user_id" = 'user_mig'`,
      );
      expect(afterFirst.rows).toHaveLength(1);
      expect(afterFirst.rows[0]?.content).toBe("existing content");
      expect(afterFirst.rows[0]?.metadata).toEqual({});

      // Mutate metadata; the rerun must not clobber it.
      await client.query(
        `UPDATE "user_profiles"
            SET "metadata" = '{"userSelfAliases":["Marcel"]}'::jsonb
          WHERE "user_id" = 'user_mig'`,
      );

      await client.query("BEGIN");
      await applyMigration();
      await client.query("COMMIT");

      const afterSecond = await client.query<{
        metadata: Record<string, unknown>;
      }>(
        `SELECT "metadata" FROM "user_profiles" WHERE "user_id" = 'user_mig'`,
      );
      expect(afterSecond.rows[0]?.metadata).toEqual({
        userSelfAliases: ["Marcel"],
      });

      // Column count check — exactly one `metadata` column.
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='user_profiles'
             AND column_name='metadata'`,
      );
      expect(columns.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
