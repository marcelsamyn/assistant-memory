import { env } from "./env";
import type db from "~/db";

let _db: typeof db | null = null;

export const useDatabase = async () => {
  if (!_db) {
    const db = await import("~/db");
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");

    if (env.RUN_MIGRATIONS === "true") {
      await migrate(db.default, {
        migrationsFolder: "./drizzle",
      });
    }

    _db = db.default;
  }
  return _db;
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
export const setTestDatabase = (override: typeof db | null): void => {
  _db = override;
};
