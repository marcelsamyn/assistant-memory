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
 * extraction LLM stub, no-op embeddings, mock source service.
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
  semanticSearchSubstringQuery = null;
}
