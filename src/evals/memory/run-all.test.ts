/**
 * Vitest integration for the memory regression eval harness.
 *
 * Runs each story as its own `it` so failures are easy to triage in CI. The
 * full suite is skipped when the test Postgres is unreachable; setting the
 * `RUN_EVALS=0` env disables the suite entirely (useful when developers run
 * a subset of tests locally without docker-compose).
 *
 * Common aliases: memory eval suite, run-all tests, harness vitest.
 */
import { describe, expect, it } from "vitest";

process.env["DATABASE_URL"] ??=
  "postgres://postgres:postgres@localhost:5431/postgres";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

const [{ isServerReachable }, { runIngestionEval }, { ALL_STORIES }] =
  await Promise.all([
    import("./db-fixture"),
    import("./runIngestionEval"),
    import("./stories"),
  ]);

const SERVER_AVAILABLE = await isServerReachable();
const ENABLED = process.env["RUN_EVALS"] !== "0";
const describeIfEnabled =
  SERVER_AVAILABLE && ENABLED ? describe : describe.skip;

describeIfEnabled("memory regression eval harness", () => {
  for (const fixture of ALL_STORIES) {
    it(`${fixture.name} — ${fixture.description}`, async () => {
      const result = await runIngestionEval(fixture);
      if (!result.passed) {
        const lines = result.failures.map((f) => `- ${f.message}`);
        throw new Error(`Story ${fixture.name} failed:\n${lines.join("\n")}`);
      }
      expect(result.passed).toBe(true);
    }, 30_000);
  }
});
