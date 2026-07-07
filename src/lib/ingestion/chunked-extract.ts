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
 * identifies the document's central thesis and 1-5 high-level themes. These
 * are folded into the source node itself — the `Document` node's label (title)
 * and description (thesis + themes) via `applyDocumentSpine` — rather than
 * materialized as separate Concept nodes. Every extracted entity is already
 * sourceLinked to that same source node, so it acts as the document's hub for
 * retrieval. The thesis and themes are also threaded into each chunk's prompt
 * so the per-fragment extractor keeps the document-wide view. Spine pre-pass
 * failures are best-effort: ingestion continues without spine if the call
 * throws.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractGraph } from "~/lib/extract-graph";
import { applyDocumentSpine } from "~/lib/ingestion/apply-document-spine";
import { chunkMarkdown } from "~/lib/ingestion/chunk-markdown";
import { extractDocumentSpine } from "~/lib/ingestion/extract-document-spine";
import { type SourceType } from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { env } from "~/utils/env";

const MAX_LENGTH_LIMIT_SPLIT_DEPTH = 4;

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
  /**
   * "Who the user is" note forwarded verbatim to every chunk's `extractGraph`
   * call so per-fragment extraction resolves the user's name correctly.
   */
  userIdentityNote?: string;
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
    userIdentityNote,
  } = params;

  const chunks = chunkMarkdown(content, env.INGEST_CHUNK_MAX_CHARS);
  const debugDir = env.INGEST_DEBUG_DIR;

  console.log(
    `chunked-extract: src=${sourceId} label=${logLabel} contentLen=${content.length} chunks=${chunks.length}`,
  );

  // chunkMarkdown returns [] only for empty input; nothing to extract from.
  if (chunks.length === 0) return;

  const { thesis, themes } = await runSpinePrepass({
    userId,
    sourceType,
    sourceId,
    content,
    documentNodeId: linkedNodeId,
    title: documentMetadata?.title,
    logLabel,
  });

  const baseExtractParams = {
    userId,
    sourceType,
    sourceId,
    statedAt,
    linkedNodeId,
    sourceRefs,
    ...(userIdentityNote ? { userIdentityNote } : {}),
  };

  let succeeded = 0;
  let failed = 0;
  let totalLeafChunks = chunks.length;
  let didReplaceClaims = false;
  const failures: Array<{ label: string; message: string }> = [];

  const extractChunk = async ({
    chunk,
    index,
    total,
    label,
    splitDepth,
  }: {
    chunk: string;
    index: number;
    total: number;
    label: string;
    splitDepth: number;
  }): Promise<void> => {
    const contentNote = buildContentNote({
      index,
      total,
      sourceType,
      ...(documentMetadata && { documentMetadata }),
      ...(thesis && { thesis }),
      ...(themes.length > 0 && { themes }),
    });
    try {
      const result = await extractGraph({
        ...baseExtractParams,
        content: chunk,
        replaceClaimsForSources: !didReplaceClaims,
        ...(contentNote && { contentNote }),
        ...(debugDir && {
          onLlmIO: makeDebugDumpHook(debugDir, sourceId, label),
        }),
      });
      didReplaceClaims = true;
      succeeded += 1;
      console.log(
        `chunked-extract:   chunk=${label}/${total} len=${chunk.length} newNodes=${result.newNodesCreated} claims=${result.claimsCreated}`,
      );
    } catch (err) {
      if (
        isOutputLengthLimitError(err) &&
        splitDepth < MAX_LENGTH_LIMIT_SPLIT_DEPTH
      ) {
        const subChunks = splitChunkForLengthLimitRetry(chunk);
        if (subChunks.length > 1) {
          totalLeafChunks += subChunks.length - 1;
          console.warn(
            `chunked-extract:   chunk=${label}/${total} len=${chunk.length} hit output length limit; retrying as ${subChunks.length} smaller chunks`,
          );
          for (const [subIndex, subChunk] of subChunks.entries()) {
            await extractChunk({
              chunk: subChunk,
              index: subIndex,
              total: subChunks.length,
              label: `${label}.${subIndex}`,
              splitDepth: splitDepth + 1,
            });
          }
          return;
        }
      }

      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ label, message });
      console.error(
        `chunked-extract:   chunk=${label}/${total} len=${chunk.length} FAILED: ${message}`,
      );
    }
  };

  for (const [index, chunk] of chunks.entries()) {
    await extractChunk({
      chunk,
      index,
      total: chunks.length,
      label: String(index),
      splitDepth: 0,
    });
  }

  if (failed > 0) {
    console.warn(
      `chunked-extract: src=${sourceId} succeeded=${succeeded}/${totalLeafChunks} failed=${failed}/${totalLeafChunks}`,
    );
    if (succeeded === 0) {
      throw new Error(
        `chunked-extract: src=${sourceId} all ${totalLeafChunks} chunk(s) failed; first error: ${failures[0]?.message}`,
      );
    }
  }
}

/**
 * Best-effort spine pre-pass for document ingestion: runs one structured LLM
 * call to identify the document's thesis and 1-5 high-level themes, then folds
 * them into the source node itself (label = title, description = thesis +
 * themes) via `applyDocumentSpine` — no separate Concept nodes. The thesis and
 * themes are also returned so each chunk's prompt keeps the document-wide view
 * it can't see fragment-by-fragment.
 *
 * Failures (LLM error, validation error) are logged and swallowed so a missing
 * spine never breaks ingestion — extraction simply runs without spine context.
 * The node write is independently best-effort so a DB hiccup there can't drop
 * the thesis we still feed to chunks.
 */
async function runSpinePrepass(params: {
  userId: string;
  sourceType: SourceType;
  sourceId: TypeId<"source">;
  content: string;
  documentNodeId: TypeId<"node">;
  title: string | undefined;
  logLabel: string;
}): Promise<{ thesis: string | null; themes: string[] }> {
  const {
    userId,
    sourceType,
    sourceId,
    content,
    documentNodeId,
    title,
    logLabel,
  } = params;
  if (sourceType !== "document" || content.trim().length === 0) {
    return { thesis: null, themes: [] };
  }

  try {
    const spine = await extractDocumentSpine({ userId, content });
    const themes = spine.spineConcepts.map((concept) => concept.label);

    try {
      await applyDocumentSpine({ documentNodeId, title, logLabel, spine });
    } catch (err) {
      console.warn(
        `chunked-extract: src=${sourceId} failed to write spine to source node:`,
        err,
      );
    }

    console.log(
      `chunked-extract: src=${sourceId} spine themes=${themes.length} thesis="${spine.thesis}"`,
    );
    return { thesis: spine.thesis, themes };
  } catch (err) {
    console.warn(
      `chunked-extract: src=${sourceId} spine pre-pass failed; continuing without spine:`,
      err,
    );
    return { thesis: null, themes: [] };
  }
}

function buildContentNote(opts: {
  index: number;
  total: number;
  sourceType: SourceType;
  documentMetadata?: { title?: string; author?: string };
  thesis?: string;
  themes?: string[];
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

  if (opts.themes && opts.themes.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Document themes: ${opts.themes.join("; ")}`);
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

function isOutputLengthLimitError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "LengthFinishReasonError" ||
      err.message.includes("length limit was reached"))
  );
}

function splitChunkForLengthLimitRetry(chunk: string): string[] {
  if (chunk.length < 2) return [];

  const targetMaxChars = Math.ceil(chunk.length / 2);
  const semanticChunks = chunkMarkdown(chunk, targetMaxChars);
  if (
    semanticChunks.length > 1 &&
    semanticChunks.every((semanticChunk) => semanticChunk.length < chunk.length)
  ) {
    return semanticChunks;
  }

  const splitIndex = findFallbackSplitIndex(chunk);
  if (splitIndex === null) return [];

  return [
    chunk.slice(0, splitIndex).trimEnd(),
    chunk.slice(splitIndex).trimStart(),
  ].filter((part) => part.length > 0);
}

function findFallbackSplitIndex(text: string): number | null {
  if (text.length < 2) return null;

  const midpoint = Math.floor(text.length / 2);
  const candidates = [
    splitBefore(text, "\n\n", midpoint),
    splitAfter(text, "\n\n", midpoint),
    splitBefore(text, "\n", midpoint),
    splitAfter(text, "\n", midpoint),
    splitBefore(text, ". ", midpoint),
    splitAfter(text, ". ", midpoint),
    splitBefore(text, " ", midpoint),
    splitAfter(text, " ", midpoint),
  ].filter(
    (candidate): candidate is number =>
      candidate !== null && candidate > 0 && candidate < text.length,
  );

  let best: number | null = null;
  for (const candidate of candidates) {
    if (
      best === null ||
      Math.abs(candidate - midpoint) < Math.abs(best - midpoint)
    ) {
      best = candidate;
    }
  }

  return best ?? midpoint;
}

function splitBefore(
  text: string,
  delimiter: string,
  index: number,
): number | null {
  const delimiterIndex = text.lastIndexOf(delimiter, index);
  if (delimiterIndex === -1) return null;
  return delimiterIndex + delimiter.length;
}

function splitAfter(
  text: string,
  delimiter: string,
  index: number,
): number | null {
  const delimiterIndex = text.indexOf(delimiter, index);
  if (delimiterIndex === -1) return null;
  return delimiterIndex + delimiter.length;
}

/**
 * Returns an `extractGraph` `onLlmIO` hook that writes the prompt and parsed
 * response for a single chunk to `<debugDir>`. Errors are logged and
 * swallowed so debug instrumentation never breaks ingestion.
 */
function makeDebugDumpHook(
  debugDir: string,
  sourceId: string,
  chunkIndex: string,
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
