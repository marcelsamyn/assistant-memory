import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { logEvent } from "~/lib/observability/log";

/** Keep the advisory lock and migration transaction on the same connection. */
export async function runDatabaseMigrations(
  connectionString: string,
  migrationsFolder = "./drizzle",
): Promise<void> {
  const startedAt = Date.now();
  let phase = "connecting";
  let statementsStarted = 0;
  const progress = (): Record<string, unknown> => ({
    phase,
    elapsedMs: Date.now() - startedAt,
    statementsStarted,
  });
  const client = new pg.Client({
    connectionString,
    ssl: false,
    connectionTimeoutMillis: 10_000,
    application_name: "assistant-memory-migrations",
  });
  client.on("notice", (notice) => {
    // Only our fixed progress protocol is safe to publish. Other PostgreSQL
    // notices can contain row content, SQL literals, or connection details.
    const match = /^memory_migration:(\d{4}):([a-z_]+)(?::(\d+))?$/.exec(
      notice.message ?? "",
    );
    if (!match) return;
    logEvent("database.migrations.backfill", {
      ...progress(),
      migration: match[1],
      step: match[2],
      ...(match[3] ? { rows: Number(match[3]) } : {}),
    });
  });
  logEvent("database.migrations.started", progress());
  const heartbeat = setInterval(() => {
    logEvent("database.migrations.progress", progress());
  }, 10_000);
  heartbeat.unref();
  try {
    await client.connect();
    phase = "waiting_for_lock";
    logEvent("database.migrations.progress", progress());
    await client.query("SELECT pg_advisory_lock($1, $2)", [1777558586, 0]);
    phase = "applying";
    logEvent("database.migrations.progress", progress());
    const database = drizzle(client, {
      logger: {
        logQuery: () => {
          statementsStarted += 1;
        },
      },
    });
    await migrate(database, { migrationsFolder });
    phase = "committed";
    logEvent("database.migrations.completed", progress());
  } catch (error: unknown) {
    const code =
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : undefined;
    logEvent("database.migrations.failed", {
      ...progress(),
      ...(code && /^[A-Z0-9_]+$/.test(code) ? { code } : {}),
    });
    throw error;
  } finally {
    clearInterval(heartbeat);
    // Closing the session releases its advisory lock, including error paths.
    await client.end();
  }
}
