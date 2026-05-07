/**
 * Shared helper for ingest jobs that need to run `extractGraph` over long
 * markdown content. Splits the input into chunks via `chunkMarkdown`, runs
 * `extractGraph` sequentially per chunk against the same source, and emits a
 * structured per-chunk log line so sparse output can be localized to a stage
 * (markdown conversion, chunking, LLM, or identity resolution).
 *
 * Sequential execution is intentional: each call's `findSimilarNodes` step
 * picks up nodes created by earlier chunks of the same run, which is what
 * keeps duplicates from being re-created with slight wording variations.
 *
 * Source-scoped claim replacement runs once on the first chunk that succeeds
 * (matches today's single-call semantics); subsequent chunks pass
 * `replaceClaimsForSources: false` so they append rather than wipe the prior
 * chunks' work.
 *
 * Per-chunk failures (e.g., a malformed LLM JSON response on one chunk of a
 * long document) are logged and the loop continues so partial progress is
 * preserved. The helper only throws when every chunk fails, which lets BullMQ
 * retry a definitively broken run while not nuking 6 successful chunks
 * because the 7th had a bad response.
 *
 * For document ingests, a spine pre-pass runs first: one cheap LLM call
 * identifies the document's central thesis and 1-5 high-level "spine"
 * concepts, materializes them as Concept nodes (via the same identity
 * resolution path everything else uses), and exposes them to each chunk's
 * extractor as pre-existing nodes. The chunk prompt instructs the LLM to
 * emit RELATED_TO claims linking concrete entities (named tools, programs,
 * decisions) back to the spine concepts, so concrete details get connected
 * to the document's purpose instead of orphaned. Spine pre-pass failures
 * are best-effort: ingestion continues without spine if the call throws.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractGraph } from "~/lib/extract-graph";
import { chunkMarkdown } from "~/lib/ingestion/chunk-markdown";
import {
  ensureSpineNodes,
  linkSpineToDocument,
  type SpineNode,
} from "~/lib/ingestion/ensure-spine-nodes";
import { extractDocumentSpine } from "~/lib/ingestion/extract-document-spine";
import { type SourceType } from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { env } from "~/utils/env";

export interface ChunkedExtractionParams {
  userId: string;
  sourceType: SourceType;
  sourceId: TypeId<"source">;
  statedAt: Date;
  linkedNodeId: TypeId<"node">;
  sourceRefs: Array<{
    externalId: string;
    sourceId: TypeId<"source">;
    statedAt?: Date;
  }>;
  content: string;
  /** Identifier shown in log lines (e.g., the upload filename). */
  logLabel: string;
  /**
   * Optional document title/author. When provided, surfaced to the LLM as a
   * "Document context:" preamble so it understands the content was authored
   * by an external party — preventing claims from being misattributed to the
   * user (e.g., "the user chose to use KDP" when the book just discussed it).
   */
  documentMetadata?: {
    title?: string;
    author?: string;
  };
}

export async function runChunkedExtraction(
  params: ChunkedExtractionParams,
): Promise<void> {
  const {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
    content,
    logLabel,
    documentMetadata,
  } = params;

  const chunks = chunkMarkdown(content, env.INGEST_CHUNK_MAX_CHARS);
  const debugDir = env.INGEST_DEBUG_DIR;

  console.log(
    `chunked-extract: src=${sourceId} label=${logLabel} contentLen=${content.length} chunks=${chunks.length}`,
  );

  // chunkMarkdown returns [] only for empty input; nothing to extract from.
  if (chunks.length === 0) return;

  const { spineNodes, thesis } = await runSpinePrepass({
    userId,
    sourceType,
    sourceId,
    content,
  });

  const baseExtractParams = {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
  };

  let succeeded = 0;
  let failed = 0;
  let didReplaceClaims = false;
  const failures: Array<{ index: number; message: string }> = [];

  for (const [index, chunk] of chunks.entries()) {
    const contentNote = buildContentNote({
      index,
      total: chunks.length,
      sourceType,
      ...(documentMetadata && { documentMetadata }),
      ...(thesis && { thesis }),
    });
    try {
      const result = await extractGraph({
        ...baseExtractParams,
        content: chunk,
        replaceClaimsForSources: !didReplaceClaims,
        ...(contentNote && { contentNote }),
        ...(spineNodes.length > 0 && { documentSpine: spineNodes }),
        ...(debugDir && {
          onLlmIO: makeDebugDumpHook(debugDir, sourceId, index),
        }),
      });
      didReplaceClaims = true;
      succeeded += 1;
      console.log(
        `chunked-extract:   chunk=${index}/${chunks.length} len=${chunk.length} newNodes=${result.newNodesCreated} claims=${result.claimsCreated}`,
      );
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ index, message });
      console.error(
        `chunked-extract:   chunk=${index}/${chunks.length} len=${chunk.length} FAILED: ${message}`,
      );
    }
  }

  if (failed > 0) {
    console.warn(
      `chunked-extract: src=${sourceId} succeeded=${succeeded}/${chunks.length} failed=${failed}/${chunks.length}`,
    );
    if (succeeded === 0) {
      throw new Error(
        `chunked-extract: src=${sourceId} all ${chunks.length} chunk(s) failed; first error: ${failures[0]?.message}`,
      );
    }
  }

  // Insert spine→document RELATED_TO claims after the chunk loop. Doing this
  // before would have them wiped by chunk 0's source-scoped claim
  // replacement; doing it after preserves them for graph traversal (a query
  // against a low-level entity → spine concept → document).
  if (succeeded > 0 && spineNodes.length > 0) {
    try {
      await linkSpineToDocument({
        userId,
        sourceId,
        documentNodeId: linkedNodeId,
        statedAt,
        spineNodes,
        documentLabel: documentMetadata?.title ?? logLabel,
      });
    } catch (err) {
      console.warn(
        `chunked-extract: src=${sourceId} failed to link spine to document:`,
        err,
      );
    }
  }
}

/**
 * Best-effort spine pre-pass for document ingestion: runs one structured LLM
 * call to identify the document's thesis and 1-5 high-level spine concepts,
 * then materializes those concepts as Concept nodes via the standard
 * identity resolution path. Failures (LLM error, validation error,
 * insertion error) are logged and swallowed so a missing spine never breaks
 * ingestion — chunked extraction simply runs without spine context.
 */
async function runSpinePrepass(params: {
  userId: string;
  sourceType: SourceType;
  sourceId: TypeId<"source">;
  content: string;
}): Promise<{ spineNodes: SpineNode[]; thesis: string | null }> {
  const { userId, sourceType, sourceId, content } = params;
  if (sourceType !== "document" || content.trim().length === 0) {
    return { spineNodes: [], thesis: null };
  }

  try {
    const spine = await extractDocumentSpine({ userId, content });
    const spineNodes = await ensureSpineNodes({ userId, sourceId, spine });
    console.log(
      `chunked-extract: src=${sourceId} spine concepts=${spineNodes.length} thesis="${spine.thesis}"`,
    );
    return { spineNodes, thesis: spine.thesis };
  } catch (err) {
    console.warn(
      `chunked-extract: src=${sourceId} spine pre-pass failed; continuing without spine:`,
      err,
    );
    return { spineNodes: [], thesis: null };
  }
}

function buildContentNote(opts: {
  index: number;
  total: number;
  sourceType: SourceType;
  documentMetadata?: { title?: string; author?: string };
  thesis?: string;
}): string | undefined {
  const lines: string[] = [];

  const title = opts.documentMetadata?.title?.trim();
  const author = opts.documentMetadata?.author?.trim();
  if (title || author) {
    lines.push("Document context:");
    if (title) lines.push(`- Title: ${title}`);
    if (author) lines.push(`- Author: ${author}`);
    lines.push(
      "Note: this document is authored by the party above (or an external author if unspecified). Do not attribute its statements, decisions, preferences, or recommendations to the user reading it.",
    );
  }

  const thesis = opts.thesis?.trim();
  if (thesis) {
    if (lines.length > 0) lines.push("");
    lines.push(`Document thesis: ${thesis}`);
  }

  if (opts.total > 1) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `This is section ${opts.index + 1} of ${opts.total} of a longer ${opts.sourceType}; extract every concrete fact in this section.`,
    );
  }

  if (lines.length === 0) return undefined;
  return lines.join("\n");
}

/**
 * Returns an `extractGraph` `onLlmIO` hook that writes the prompt and parsed
 * response for a single chunk to `<debugDir>`. Errors are logged and
 * swallowed so debug instrumentation never breaks ingestion.
 */
function makeDebugDumpHook(
  debugDir: string,
  sourceId: string,
  chunkIndex: number,
): (info: { prompt: string; response: unknown }) => Promise<void> {
  return async ({ prompt, response }) => {
    try {
      await mkdir(debugDir, { recursive: true });
      const base = join(debugDir, `${sourceId}-chunk-${chunkIndex}`);
      await Promise.all([
        writeFile(`${base}-prompt.txt`, prompt, "utf-8"),
        writeFile(
          `${base}-response.json`,
          JSON.stringify(response, null, 2),
          "utf-8",
        ),
      ]);
    } catch (err) {
      console.error(
        `chunked-extract: failed to write debug dump for ${sourceId} chunk ${chunkIndex}`,
        err,
      );
    }
  };
}
