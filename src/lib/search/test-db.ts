/**
 * Test-only helper: provision a fresh Postgres database, run all Drizzle
 * migrations against it (so generated tsvector columns and pg_trgm indexes
 * exist exactly as in production), and register it as the global db handle.
 *
 * Common aliases: createMigratedTestDb, search test database, hybrid search
 * test setup.
 */
// Load .env before importing ~/utils/db, which parses env eagerly at module
// load. Without this, running a search DB test in isolation fails env
// validation (it otherwise only worked when another suite loaded env first).
import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { DrizzleDB } from "~/db";
import * as schema from "~/db/schema";
import { setTestDatabase } from "~/utils/db";

const HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const USER = process.env["TEST_PG_USER"] ?? "postgres";
const PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

export const adminDsn = (): string =>
  `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${ADMIN_DB}`;
const dsnFor = (db: string): string =>
  `postgres://${USER}:${PASSWORD}@${HOST}:${PORT}/${db}`;

export interface MigratedTestDb {
  db: DrizzleDB;
  client: pg.Client;
  drop: () => Promise<void>;
}

export async function isServerReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export async function createMigratedTestDb(
  dbName: string,
): Promise<MigratedTestDb> {
  const admin = new pg.Client({ connectionString: adminDsn() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const client = new pg.Client({ connectionString: dsnFor(dbName) });
  await client.connect();
  const db = drizzle(client, {
    schema,
    casing: "snake_case",
  }) as unknown as DrizzleDB;
  await migrate(db, { migrationsFolder: "./drizzle" });
  setTestDatabase(db);

  const drop = async (): Promise<void> => {
    setTestDatabase(null);
    await client.end();
    const a = new pg.Client({ connectionString: adminDsn() });
    await a.connect();
    await a.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await a.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await a.end();
  };

  return { db, client, drop };
}
