/**
 * Ingestion probe — feed ONE document through the *real* extraction pipeline
 * against the *real* model, into a throwaway database, then print and persist
 * a legible report plus an automated coverage score. The fast inner loop for
 * tuning the extraction prompt / model: edit, re-run, read the score.
 *
 * It calls the same `extractDocumentGraph` the document/file workers use, so
 * the spine pre-pass, markdown chunking, and extraction prompt all run exactly
 * as in production. Only the side-channels that don't change *what gets
 * extracted* are stubbed via `~/utils/test-overrides`:
 *   - embeddings (Jina)            → setSkipEmbeddingPersistence
 *   - semantic search (pgvector)   → setSkipSemanticSearch (empty on a fresh DB)
 *   - source storage (MinIO)       → createStubSourceService
 *   - background jobs (BullMQ)     → setSkipJobEnqueue (no worker, no Redis)
 * The extraction LLM seam is deliberately left OFF, so the real client runs.
 *
 * Usage:
 *   pnpm run eval:ingest --file <path> [--title T] [--author A]
 *                        [--model <id>] [--judge-model <id>]
 *                        [--judge per-chunk|whole] [--no-judge] [--keep-db]
 *                        [--user <id>]
 *
 * The model can also be set the idiomatic way:
 *   MODEL_ID_GRAPH_EXTRACTION=<id> pnpm run eval:ingest --file <path>
 *
 * Requires the dev Postgres on port 5431 and real MEMORY_OPENAI_* / model env
 * (loaded from .env). Services we never contact (Redis, MinIO, Jina) get
 * harmless placeholder env so a minimal .env still boots.
 *
 * Common aliases: ingestion probe, extraction tuning harness, coverage probe,
 * real-model ingest test, prompt iteration loop.
 */
import type {
  CoverageResult,
  ProbeAlias,
  ProbeClaim,
  ProbeNode,
} from "./probe-report";
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";

const { values } = parseArgs({
  options: {
    file: { type: "string" },
    title: { type: "string" },
    author: { type: "string" },
    model: { type: "string" },
    "judge-model": { type: "string" },
    judge: { type: "string" }, // "per-chunk" (default) | "whole"
    "no-judge": { type: "boolean" },
    "keep-db": { type: "boolean" },
    user: { type: "string" },
  },
  allowPositionals: true,
});

// Apply the model override and placeholder env for never-contacted services
// BEFORE any module that reads `~/utils/env` is imported (all app imports
// below are dynamic, so this runs first).
if (values.model) process.env["MODEL_ID_GRAPH_EXTRACTION"] = values.model;
process.env["DATABASE_URL"] ??=
  "postgres://postgres:postgres@localhost:5431/postgres";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["JINA_API_KEY"] ??= "unused-in-probe";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "unused-in-probe";
process.env["MINIO_SECRET_KEY"] ??= "unused-in-probe";
process.env["SOURCES_BUCKET"] ??= "unused-probe";

const coverageSchema = z.object({
  coverageScore: z
    .number()
    .describe("0-100, fraction of salient facts in this passage captured"),
  salientFacts: z.array(
    z.object({
      fact: z.string().describe("one concrete fact asserted in the passage"),
      captured: z
        .boolean()
        .describe("true only if a node/claim actually represents this fact"),
      capturedAs: z
        .string()
        .describe("the node/claim that captures it, or empty string if missed"),
    }),
  ),
  summary: z.string().describe("one-sentence coverage assessment"),
});
type CoverageJudgement = z.infer<typeof coverageSchema>;

function buildJudgePrompt(passage: string, factsText: string): string {
  return `You are auditing a knowledge-graph extraction for COVERAGE: did the graph capture everything stated in the source?

Below is (1) a source passage and (2) the facts the extractor produced from the whole document.

List the SALIENT facts asserted in the source passage — concrete claims, named entities, relationships, decisions, recommendations, and numbers. Ignore filler, hedging, and rhetorical scaffolding. For each salient fact, decide whether it is represented ANYWHERE in the extracted facts, and set "captured" accordingly.

Be strict:
- A fact counts as captured only if a specific node or claim actually represents it. A generic high-level concept does NOT count as capturing the specifics beneath it.
- Prefer many small atomic facts over a few broad ones, so coverage gaps are visible.

<source_passage>
${passage}
</source_passage>

<extracted_facts>
${factsText}
</extracted_facts>`;
}

async function main(): Promise<void> {
  const file = values.file;
  if (!file) {
    throw new Error(
      "Missing --file. Usage: pnpm run eval:ingest --file <path> [--model id] [--judge per-chunk|whole] [--no-judge]",
    );
  }

  const content = await readFile(resolve(file), "utf-8");
  const userId = values.user ?? "probe_user";
  const title = values.title;
  const author = values.author;
  const judgeMode: "per-chunk" | "whole" | "off" = values["no-judge"]
    ? "off"
    : values.judge === "whole"
      ? "whole"
      : "per-chunk";

  // Dynamic imports: env is parsed here, after the overrides above are set.
  const { createEvalDatabase, isServerReachable } = await import(
    "./db-fixture"
  );

  if (!(await isServerReachable())) {
    throw new Error(
      "Test Postgres not reachable on port 5431. Bring up the dev database first: `docker compose up -d db`.",
    );
  }
  const { createStubSourceService } = await import("./extraction-stubs");
  const { env } = await import("~/utils/env");
  const { setTestDatabase } = await import("~/utils/db");
  const overrides = await import("~/utils/test-overrides");
  const { ensureUser } = await import("~/lib/ingestion/ensure-user");
  const { extractDocumentGraph } = await import(
    "~/lib/ingestion/extract-document-graph"
  );
  const { chunkMarkdown } = await import("~/lib/ingestion/chunk-markdown");
  const { createCompletionClient, parseStructuredCompletion } = await import(
    "~/lib/ai"
  );
  const { nodes, nodeMetadata, claims, aliases, sourceLinks } = await import(
    "~/db/schema"
  );
  const { and, eq } = await import("drizzle-orm");
  const report = await import("./probe-report");

  const model = env.MODEL_ID_GRAPH_EXTRACTION;
  const judgeModel = values["judge-model"] ?? env.MODEL_ID_GRAPH_EXTRACTION;
  const chunkCount = chunkMarkdown(content, env.INGEST_CHUNK_MAX_CHARS).length;
  const generatedAt = new Date().toISOString();
  const startedAt = Date.now();

  const provisioned = await createEvalDatabase("probe");
  const db = provisioned.db;

  console.log(
    `\nprobe: file=${file} len=${content.length} chunks=${chunkCount} model=${model} db=${provisioned.dbName}\n`,
  );

  try {
    setTestDatabase(db);
    overrides.setSkipEmbeddingPersistence(true);
    overrides.setSkipSemanticSearch(true);
    overrides.setSkipJobEnqueue(true);
    overrides.setSourceServiceOverride(createStubSourceService(db));
    // NB: extraction LLM seam intentionally left off → real model runs.

    await ensureUser(db, userId);

    const externalId = `probe:${basename(file)}`;
    const timestamp = new Date();
    const sourceService = createStubSourceService(db);
    const { successes } = await sourceService.insertMany([
      {
        userId,
        sourceType: "document",
        externalId,
        timestamp,
        content,
        scope: "personal",
        ...(title || author
          ? { metadata: { ...(title && { title }), ...(author && { author }) } }
          : {}),
      },
    ]);
    const sourceId = successes[0];
    if (!sourceId) throw new Error("Failed to create probe source row.");

    // --- Real extraction (spine + chunk + per-chunk extractGraph) ---
    await extractDocumentGraph({
      db,
      userId,
      sourceId,
      externalId,
      content,
      timestamp,
      logLabel: title ?? basename(file),
      ...(title !== undefined && { title }),
      ...(author !== undefined && { author }),
    });

    // --- Read the graph back ---
    const nodeRows = await db
      .select({
        id: nodes.id,
        type: nodes.nodeType,
        label: nodeMetadata.label,
        description: nodeMetadata.description,
      })
      .from(nodes)
      .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(eq(nodes.userId, userId));

    const labelById = new Map<string, string | null>(
      nodeRows.map((n) => [n.id, n.label]),
    );

    const probeNodes: ProbeNode[] = nodeRows.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      description: n.description,
    }));

    const claimRows = await db
      .select({
        predicate: claims.predicate,
        statement: claims.statement,
        assertedByKind: claims.assertedByKind,
        subjectNodeId: claims.subjectNodeId,
        objectNodeId: claims.objectNodeId,
        objectValue: claims.objectValue,
      })
      .from(claims)
      .where(eq(claims.userId, userId));

    const probeClaims: ProbeClaim[] = claimRows.map((c) => ({
      predicate: c.predicate,
      statement: c.statement,
      assertedByKind: c.assertedByKind,
      subjectLabel: labelById.get(c.subjectNodeId) ?? null,
      objectLabel: c.objectNodeId
        ? (labelById.get(c.objectNodeId) ?? null)
        : null,
      objectValue: c.objectValue,
    }));

    const aliasRows = await db
      .select({
        aliasText: aliases.aliasText,
        canonicalNodeId: aliases.canonicalNodeId,
      })
      .from(aliases)
      .where(eq(aliases.userId, userId));

    const probeAliases: ProbeAlias[] = aliasRows.map((a) => ({
      aliasText: a.aliasText,
      canonicalLabel: labelById.get(a.canonicalNodeId) ?? null,
    }));

    // Spine concepts: Concept nodes linked to the Document node via RELATED_TO.
    const [docNode] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .innerJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          eq(nodes.nodeType, "Document"),
          eq(sourceLinks.sourceId, sourceId),
        ),
      )
      .limit(1);

    let spineConcepts: string[] = [];
    if (docNode) {
      const spineRows = await db
        .select({ subjectNodeId: claims.subjectNodeId })
        .from(claims)
        .where(
          and(
            eq(claims.userId, userId),
            eq(claims.predicate, "RELATED_TO"),
            eq(claims.objectNodeId, docNode.id),
          ),
        );
      spineConcepts = spineRows
        .map((r) => labelById.get(r.subjectNodeId) ?? null)
        .filter((l): l is string => l !== null);
    }

    // --- Coverage judge ---
    let coverage: CoverageResult | null = null;
    if (judgeMode !== "off") {
      const factsText = report.renderFactsForJudge(
        probeNodes,
        probeClaims,
        probeAliases,
      );
      const segments =
        judgeMode === "whole"
          ? [content]
          : chunkMarkdown(content, env.INGEST_CHUNK_MAX_CHARS);

      const client = await createCompletionClient(userId);
      const judgements: CoverageJudgement[] = [];
      for (const [i, segment] of segments.entries()) {
        console.log(`probe: judging segment ${i + 1}/${segments.length}…`);
        const completion = await parseStructuredCompletion(client, {
          model: judgeModel,
          messages: [
            { role: "user", content: buildJudgePrompt(segment, factsText) },
          ],
          response_format: zodResponseFormat(coverageSchema, "coverage"),
        });
        const parsed = completion.choices[0]?.message.parsed;
        if (parsed) judgements.push(parsed);
      }

      const allFacts = judgements.flatMap((j) => j.salientFacts);
      const capturedCount = allFacts.filter((f) => f.captured).length;
      const salientCount = allFacts.length;
      coverage = {
        coverageScore:
          salientCount === 0
            ? 100
            : Math.round((capturedCount / salientCount) * 100),
        capturedCount,
        salientCount,
        missedFacts: allFacts.filter((f) => !f.captured).map((f) => f.fact),
        summary:
          judgements.length === 1
            ? judgements[0]!.summary
            : judgements
                .map((j, i) => `Segment ${i + 1}: ${j.summary}`)
                .join("\n"),
      };
    }

    // --- Render + persist ---
    const stats = report.computeStats({
      nodes: probeNodes,
      claims: probeClaims,
      aliasCount: probeAliases.length,
      contentLength: content.length,
      chunkCount,
    });

    const reportMd = report.renderReport({
      config: {
        file,
        model,
        judgeModel: judgeMode === "off" ? null : judgeModel,
        judgeMode,
        title,
        author,
        chunkMaxChars: env.INGEST_CHUNK_MAX_CHARS,
        userId,
        generatedAt,
      },
      stats,
      spineConcepts,
      nodes: probeNodes,
      claims: probeClaims,
      aliases: probeAliases,
      coverage,
      durationMs: Date.now() - startedAt,
    });

    const resultsDir = join(process.cwd(), "src/evals/memory/probe-results");
    await mkdir(resultsDir, { recursive: true });
    const safe = (s: string): string => s.replace(/[^a-z0-9._-]/gi, "_");
    const outPath = join(
      resultsDir,
      `${safe(generatedAt)}__${safe(basename(file))}__${safe(model)}.md`,
    );
    await writeFile(outPath, reportMd, "utf-8");

    console.log("\n" + reportMd);
    console.log(`\nprobe: report written to ${outPath}`);
  } finally {
    setTestDatabase(null);
    overrides.resetTestOverrides();
    if (values["keep-db"]) {
      console.log(
        `probe: --keep-db set; inspect with: psql ${provisioned.dbName} (host localhost:5431). It will NOT be dropped.`,
      );
    } else {
      await provisioned.cleanup();
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("\nprobe failed:", err);
    if (
      err instanceof Error &&
      /MEMORY_OPENAI|MODEL_ID|environment/i.test(err.message)
    ) {
      console.error(
        "\nHint: the probe hits the real model — ensure MEMORY_OPENAI_API_KEY, MEMORY_OPENAI_API_BASE_URL and MODEL_ID_GRAPH_EXTRACTION are set in .env.",
      );
    }
    process.exit(1);
  });
