/**
 * Imports a Google AI Studio conversation export into Assistant Memory as a
 * speaker-attributed transcript. Built for ongoing roleplay/coaching chats:
 * re-run it after every fresh export and only the turns newer than the last run
 * are sent — tracked by a local watermark.
 *
 * What gets excluded automatically (see ./aistudio-import/parse.ts): pasted
 * Drive attachments (dossiers, books — they carry no inline text), the model's
 * internal `isThought` reasoning, and errored generations.
 *
 * Works against two hosts (see ./aistudio-import/targets.ts):
 *   --host memory  (default) → direct Memory server: needs MEMORY_USER_ID
 *   --host petals            → a Petals proxy (api key derives the user)
 *
 * Usage:
 *   pnpm run tsx scripts/import-aistudio.ts --file ~/Downloads/chat.json [--dry-run]
 *
 * Configuration (env, or .env at the repo root; CLI flags override):
 *   MEMORY_API_URL   base URL of the host       (default http://localhost:3000)
 *   MEMORY_API_KEY   bearer / api key            (--api-key-env to use another var)
 *   MEMORY_USER_ID   user id (required for --host memory)
 *
 * Flags: --file (required) --host memory|petals --api-url --api-key-env
 *   --user-id --coach-label --self-alias (repeatable) --scope personal|reference
 *   --batch-size --id-prefix --dry-run --reset-watermark
 */
import {
  chunkIntoBatches,
  extractConversationTurns,
  latestTimestamp,
  parseExport,
  slugify,
  toUtterances,
  turnsAfter,
  type ConversationTurn,
} from "./aistudio-import/parse.js";
import {
  buildIngestBody,
  targetFor,
  type Host,
} from "./aistudio-import/targets.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

const SCRIPT_DIR = import.meta.dirname ?? ".";
const WATERMARK_PATH = join(SCRIPT_DIR, "aistudio-import", ".watermarks.json");

const ingestResponseSchema = z.object({
  sourceId: z.string().optional(),
  jobId: z.string().optional(),
  message: z.string().optional(),
});

type Watermarks = Record<string, string>;

/** Load the repo-root `.env` into process.env (without overriding real env). */
function loadDotEnv(): void {
  const envPath = join(SCRIPT_DIR, "..", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function readWatermarks(): Watermarks {
  if (!existsSync(WATERMARK_PATH)) return {};
  return JSON.parse(readFileSync(WATERMARK_PATH, "utf8")) as Watermarks;
}

function writeWatermark(key: string, value: string): void {
  const all = readWatermarks();
  all[key] = value;
  writeFileSync(WATERMARK_PATH, JSON.stringify(all, null, 2) + "\n");
}

function transcriptIdFor(prefix: string, occurredAt: string): string {
  return `${prefix}-${occurredAt.replace(/[^0-9A-Za-z]/g, "-")}`;
}

function occurredAtOf(batch: ConversationTurn[]): string {
  const first = batch[0]?.createTime;
  if (!first) throw new Error("Batch's first turn has no createTime.");
  return first;
}

async function main() {
  loadDotEnv();

  const { values } = parseArgs({
    options: {
      file: { type: "string" },
      host: { type: "string" },
      "api-url": { type: "string" },
      "api-key-env": { type: "string" },
      "user-id": { type: "string" },
      "coach-label": { type: "string" },
      "self-alias": { type: "string", multiple: true },
      scope: { type: "string" },
      "batch-size": { type: "string" },
      "id-prefix": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "reset-watermark": { type: "boolean", default: false },
    },
  });

  const file = values.file;
  if (!file) throw new Error("--file is required.");

  const host: Host = values.host === "petals" ? "petals" : "memory";
  if (values.host && values.host !== "petals" && values.host !== "memory") {
    throw new Error(
      `--host must be "memory" or "petals", got "${values.host}".`,
    );
  }
  const apiUrl =
    values["api-url"] ??
    process.env["MEMORY_API_URL"] ??
    "http://localhost:3000";
  const apiKeyEnv = values["api-key-env"] ?? "MEMORY_API_KEY";
  const apiKey = process.env[apiKeyEnv];
  const userId = values["user-id"] ?? process.env["MEMORY_USER_ID"];
  const coachLabel = values["coach-label"] ?? "Assistant";
  const selfAliases =
    values["self-alias"] && values["self-alias"].length > 0
      ? values["self-alias"]
      : ["You"];
  const selfLabel = selfAliases[0] ?? "You";
  const scope = values.scope === "reference" ? "reference" : "personal";
  const batchSize = Number.parseInt(values["batch-size"] ?? "40", 10);
  const idPrefix = values["id-prefix"] ?? slugify(basename(file));
  const dryRun = values["dry-run"];

  const target = targetFor(host, apiUrl);
  const watermarkKey = `${new URL(apiUrl).host}::${basename(file)}`;

  const parsed = parseExport(JSON.parse(readFileSync(file, "utf8")));
  const allTurns = extractConversationTurns(parsed);
  const watermark = values["reset-watermark"]
    ? undefined
    : readWatermarks()[watermarkKey];
  const newTurns = turnsAfter(allTurns, watermark);
  const batches = chunkIntoBatches(newTurns, batchSize);

  console.log(`Source:     ${file}`);
  console.log(`Endpoint:   ${target.endpoint}  (host: ${host})`);
  console.log(
    `Auth:       ${apiKeyEnv} ${apiKey ? "present ✅" : "missing"}${target.requiresUserId ? `  |  user: ${userId ?? "MISSING ❌"}` : ""}`,
  );
  console.log(
    `Shape:      scope ${scope}  |  coach "${coachLabel}"  |  self ${selfAliases.join(", ")}  |  id "${idPrefix}-…"`,
  );
  console.log(
    `Turns:      ${allTurns.length} real (of ${parsed.chunkedPrompt.chunks.length} chunks) — ${parsed.chunkedPrompt.chunks.length - allTurns.length} excluded`,
  );
  console.log(`Watermark:  ${watermark ?? "(none — full import)"}`);
  console.log(
    `To ingest:  ${newTurns.length} new turns in ${batches.length} batch(es)`,
  );

  if (newTurns.length === 0) {
    console.log("Nothing new to ingest. ✅");
    return;
  }

  if (dryRun) {
    batches.forEach((batch, i) => {
      const occurredAt = occurredAtOf(batch);
      const preview = (batch[0]?.text ?? "").slice(0, 60).replace(/\s+/g, " ");
      console.log(
        `  [dry] batch ${i + 1}: ${batch.length} turns | ${transcriptIdFor(idPrefix, occurredAt)} | "${preview}…"`,
      );
    });
    console.log("\nDry run — no API calls, watermark untouched.");
    return;
  }

  if (host === "petals" && !apiKey) {
    throw new Error(
      `${apiKeyEnv} not set — a Petals host needs an API key (x-api-key).`,
    );
  }

  for (const [i, batch] of batches.entries()) {
    const occurredAt = occurredAtOf(batch);
    const body = buildIngestBody({
      target,
      transcriptId: transcriptIdFor(idPrefix, occurredAt),
      occurredAt,
      scope,
      utterances: toUtterances(batch, { selfLabel, coachLabel }),
      selfAliases,
      userId,
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (apiKey) Object.assign(headers, target.authHeaders(apiKey));

    const resp = await fetch(target.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `batch ${i + 1} failed: HTTP ${resp.status} ${await resp.text()}`,
      );
    }
    const data = ingestResponseSchema.parse(await resp.json());
    const lastTs = latestTimestamp(batch);
    if (lastTs) writeWatermark(watermarkKey, lastTs);
    console.log(
      `  ✅ batch ${i + 1}/${batches.length}: ${batch.length} turns → source ${data.sourceId ?? "?"} (job ${data.jobId ?? "?"})`,
    );
  }
  console.log("\nDone. Memory ingestion runs async on the backend.");
}

main().catch((err: unknown) => {
  console.error("Import failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
