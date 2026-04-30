/**
 * CLI entry point for the memory regression eval harness.
 *
 * Walks every story in `ALL_STORIES` sequentially, writes a JSON artifact
 * (`eval-output/memory-eval.json`) and a Markdown summary
 * (`eval-output/memory-eval.md`), and exits non-zero on any failure.
 *
 * Suitable for CI: requires the test Postgres on port 5431 to be reachable.
 * Skipped (with a clear log line) when it is not, so local runs without
 * docker-compose up don't false-fail.
 *
 * Common aliases: eval runner, regression CI script, memory eval artifacts.
 */
// Provide harmless defaults for env vars the harness never exercises (Redis,
// MinIO, OpenAI). The harness reaches Postgres directly via the test DSN; no
// other service is contacted. These defaults must be set before any module
// imports `~/utils/env`.
import "dotenv/config";
process.env["DATABASE_URL"] ??= "postgres://postgres:postgres@localhost:5431/postgres";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

import { isServerReachable } from "./db-fixture";
import { runIngestionEval } from "./runIngestionEval";
import { ALL_STORIES } from "./stories";
import type { EvalResult } from "./types";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface RunSummary {
  generatedAt: string;
  totalStories: number;
  passed: number;
  failed: number;
  totalDurationMs: number;
  results: EvalResult[];
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function renderMarkdown(summary: RunSummary): string {
  const lines: string[] = [
    "# Memory Regression Eval Report",
    "",
    `Generated: \`${summary.generatedAt}\``,
    `Stories: ${summary.totalStories} · Passed: ${summary.passed} · Failed: ${summary.failed}`,
    `Total duration: ${summary.totalDurationMs} ms`,
    "",
    "| # | Story | Status | Duration | Failures |",
    "|---|-------|--------|----------|----------|",
  ];
  summary.results.forEach((r, i) => {
    const status = r.passed ? "PASS" : "FAIL";
    lines.push(
      `| ${i + 1} | \`${r.fixture}\` | ${status} | ${r.durationMs} ms | ${r.failures.length} |`,
    );
  });
  for (const r of summary.results) {
    if (r.passed && r.failures.length === 0) continue;
    lines.push("", `## ${r.fixture}`, "", `_${r.description}_`, "");
    if (!r.passed) {
      lines.push("### Failures", "");
      for (const f of r.failures) {
        lines.push(`- **${f.kind}** — ${f.description}`);
        lines.push(`  - ${f.message}`);
      }
    }
    lines.push("", "### Claim count snapshot", "");
    const keys = Object.keys(r.claimCounts).sort();
    if (keys.length === 0) {
      lines.push("_(no claims)_");
    } else {
      lines.push("| key | count |", "|---|---|");
      for (const key of keys) {
        lines.push(`| \`${key}\` | ${r.claimCounts[key]} |`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

export async function runAll(): Promise<RunSummary> {
  const start = Date.now();
  const results: EvalResult[] = [];

  if (!(await isServerReachable())) {
    console.error(
      "[eval] Test Postgres not reachable on port 5431; aborting. Bring up docker-compose first.",
    );
    process.exit(2);
  }

  for (const fixture of ALL_STORIES) {
    process.stderr.write(`[eval] running ${fixture.name}…`);
    const result = await runIngestionEval(fixture);
    results.push(result);
    process.stderr.write(
      ` ${result.passed ? "PASS" : "FAIL"} (${result.durationMs} ms)\n`,
    );
    if (!result.passed) {
      for (const failure of result.failures) {
        process.stderr.write(`    - ${failure.message}\n`);
      }
    }
  }

  const summary: RunSummary = {
    generatedAt: new Date().toISOString(),
    totalStories: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    totalDurationMs: Date.now() - start,
    results,
  };

  const outDir = resolve(process.cwd(), "eval-output");
  await writeJson(resolve(outDir, "memory-eval.json"), summary);
  await writeFile(
    resolve(outDir, "memory-eval.md"),
    renderMarkdown(summary),
    "utf8",
  );
  process.stderr.write(
    `[eval] wrote ${resolve(outDir, "memory-eval.json")} and memory-eval.md\n`,
  );
  return summary;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runAll()
    .then((summary) => {
      if (summary.failed > 0) process.exit(1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
