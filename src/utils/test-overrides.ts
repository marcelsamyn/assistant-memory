/**
 * Process-level test seams for the memory regression eval harness.
 *
 * Mirrors the `setTestDatabase` pattern in `~/utils/db.ts`: production
 * modules consult these overrides at call sites; production code never sets
 * them. The eval harness (`src/evals/memory`) flips them on per-fixture so
 * the real ingestion pipeline (extract-graph, transcript ingestion) runs
 * against an ephemeral Postgres without reaching out to the LLM, MinIO, or
 * Jina.
 *
 * Each setter is independent so a fixture can opt into the smallest seam set
 * it needs. Vitest module mocks are intentionally avoided — the harness is
 * also driven from a standalone CLI (`pnpm run eval:memory`) where vitest
 * isn't loaded.
 *
 * Common aliases: harness seams, test overrides, eval extraction stub,
 * extraction LLM stub, no-op embeddings, mock source service, skip job
 * enqueue, no worker, no redis.
 */
import type OpenAI from "openai";
import type { SourceCreateInput } from "~/lib/sources";
import type { TypeId } from "~/types/typeid";

/**
 * Minimal subset of the OpenAI client surface that `extractGraph` and
 * `defaultSegmentTranscriptClient` exercise. Stubs only need to implement
 * `beta.chat.completions.parse` returning the structured-response shape.
 */
export type StubCompletionClient = Pick<OpenAI, "beta">;

export interface StubSourceServiceInsertResult {
  successes: TypeId<"source">[];
  failures: Array<{ sourceId?: TypeId<"source">; reason: string }>;
}

export interface StubSourceService {
  insertMany(
    inputs: SourceCreateInput[],
  ): Promise<StubSourceServiceInsertResult>;
}

let extractionClientOverride: StubCompletionClient | null = null;
let sourceServiceOverride: StubSourceService | null = null;
let skipEmbeddingPersistence = false;
let skipSemanticSearch = false;
let skipJobEnqueue = false;
let semanticSearchSubstringQuery: string | null = null;

export function setExtractionClientOverride(
  client: StubCompletionClient | null,
): void {
  extractionClientOverride = client;
}

export function getExtractionClientOverride(): StubCompletionClient | null {
  return extractionClientOverride;
}

export function setSourceServiceOverride(
  service: StubSourceService | null,
): void {
  sourceServiceOverride = service;
}

export function getSourceServiceOverride(): StubSourceService | null {
  return sourceServiceOverride;
}

export function setSkipEmbeddingPersistence(skip: boolean): void {
  skipEmbeddingPersistence = skip;
}

export function shouldSkipEmbeddingPersistence(): boolean {
  return skipEmbeddingPersistence;
}

export function setSkipSemanticSearch(skip: boolean): void {
  skipSemanticSearch = skip;
}

export function shouldSkipSemanticSearch(): boolean {
  return skipSemanticSearch;
}

/**
 * When set, `extractGraph` skips its post-extraction job enqueues
 * (profile-synthesis, identity-reeval, atlas-invalidation). Because each
 * enqueue path reaches BullMQ via a dynamic `import("./queues")`, skipping
 * them means `queues.ts` — which starts a `Worker` and opens a Redis
 * connection as an import side effect — never loads. That keeps standalone
 * extraction probes (`pnpm run eval:ingest`) from spawning a competing
 * worker that would steal jobs from a running dev server or hang the process
 * open. Default-off, so production and the regression harness are unaffected.
 */
export function setSkipJobEnqueue(skip: boolean): void {
  skipJobEnqueue = skip;
}

export function shouldSkipJobEnqueue(): boolean {
  return skipJobEnqueue;
}

/**
 * When set, `findSimilarNodes` / `findSimilarClaims` substitute a substring
 * fallback for the embedding-based vector search. The fallback walks the
 * harness DB with the same scope / `assertedByKind` / status / validTo
 * filters as production, then drops rows whose `label` (nodes) or `statement`
 * (claims) does not contain the query substring (case-insensitive). Lets the
 * eval harness exercise the SQL-level scope filter and the card-level
 * `keepScope` post-filter without provisioning pgvector or seeding 1024-dim
 * vectors.
 *
 * Intentionally orthogonal to `setSkipSemanticSearch`: when this seam is set
 * the substring fallback wins; when it is null and `shouldSkipSemanticSearch`
 * is true the helpers return `[]` as before.
 */
export function setSemanticSearchSubstringQuery(query: string | null): void {
  semanticSearchSubstringQuery = query;
}

export function getSemanticSearchSubstringQuery(): string | null {
  return semanticSearchSubstringQuery;
}

/** Reset every harness seam to its production-default. */
export function resetTestOverrides(): void {
  extractionClientOverride = null;
  sourceServiceOverride = null;
  skipEmbeddingPersistence = false;
  skipSemanticSearch = false;
  skipJobEnqueue = false;
  semanticSearchSubstringQuery = null;
}
