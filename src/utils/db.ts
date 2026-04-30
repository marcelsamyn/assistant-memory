import { env } from "./env";
import type { DrizzleDB } from "~/db";

let _db: DrizzleDB | null = null;
let _dbInit: Promise<DrizzleDB> | null = null;

async function runMigrations(db: DrizzleDB): Promise<void> {
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const { Client } = await import("pg");
  const lockClient = new Client({
    connectionString: env.DATABASE_URL,
    ssl: false,
  });

  await lockClient.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1, $2)", [1777558586, 0]);
    await migrate(db, {
      migrationsFolder: "./drizzle",
    });
  } finally {
    await lockClient.query(
      "SELECT pg_advisory_unlock($1, $2)",
      [1777558586, 0],
    );
    await lockClient.end();
  }
}

async function loadDatabase(): Promise<DrizzleDB> {
  const db = await import("~/db");

  if (env.RUN_MIGRATIONS === "true") {
    await runMigrations(db.default);
  }

  _db = db.default;
  return db.default;
}

export const useDatabase = async (): Promise<DrizzleDB> => {
  if (_db) return _db;
  if (!_dbInit) {
    _dbInit = loadDatabase().catch((error: unknown) => {
      _dbInit = null;
      throw error;
    });
  }
  return _dbInit;
};

/**
 * Test/eval-harness seam: override the database used by `useDatabase` for the
 * lifetime of a fixture. Pass `null` to clear and let the next call lazily
 * load the production db. Common aliases: test database override, harness db
 * seam, eval db.
 *
 * Production code never calls this; it exists so the regression eval harness
 * (`src/evals/memory`) can run against an ephemeral test database without
 * relying on vitest's module mocks (which don't apply when the CLI script
 * `pnpm run eval:memory` runs outside a vitest worker).
 */
export const setTestDatabase = (override: DrizzleDB | null): void => {
  _db = override;
  _dbInit = override ? Promise.resolve(override) : null;
};
