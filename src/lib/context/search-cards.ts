/**
 * Card-shaped search APIs (`searchMemory`, `searchReference`) — the Phase 3
 * read surface that backs the MCP `search_memory` and `search_reference`
 * tools and the new `POST /context/search` route.
 *
 * Both functions return `{ cards, evidence }`:
 *   - `cards`: NodeCard[] in rerank order, batch-loaded via `getNodeCards`.
 *   - `evidence`: compact ClaimEvidence[] over the underlying claim hits, so
 *     callers can cite specific sources without re-walking the cards.
 *
 * Scope handling is end-to-end:
 *   - `searchMemory` runs `findSimilarNodes` / `findSimilarClaims` with their
 *     default `includeReference=false` and then drops any card whose derived
 *     scope resolved to `reference` (defense-in-depth: a node touched by a
 *     personal claim still surfaces but only as personal).
 *   - `searchReference` flips the flag, then drops any card whose derived
 *     scope is not `reference` so personal-supported nodes don't leak into
 *     reference results.
 *
 * Common aliases: searchMemory, searchReference, search_memory, search_reference,
 * card search, /context/search.
 */
import { generateEmbeddings } from "../embeddings";
import { findSimilarClaims, findSimilarNodes } from "../graph";
import { getNodeCards } from "./node-card";
import type { ClaimEvidence } from "./types";
import type { NodeCard } from "./node-card-types";
import type { NodeType, Scope } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { getSemanticSearchSubstringQuery } from "~/utils/test-overrides";

export interface SearchCardsRequest {
  userId: string;
  query: string;
  limit?: number | undefined;
  /**
   * Excludes specific node types from the underlying node similarity scan.
   * Mirrors the existing `/query/search` default of dropping `AssistantDream`
   * and `Temporal` so the card response is dominated by entity matches.
   */
  excludeNodeTypes?: NodeType[] | undefined;
}

export interface SearchCardsResponse {
  query: string;
  cards: NodeCard[];
  evidence: ClaimEvidence[];
}

const DEFAULT_LIMIT = 10;
const MIN_SIMILARITY = 0.4;

async function embedQuery(query: string): Promise<number[]> {
  const res = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.query",
    input: [query],
    truncate: true,
  });
  const embedding = res.data[0]?.embedding;
  if (!embedding) throw new Error("Failed to generate embedding");
  return embedding;
}

interface ScopeFilter {
  /** Passed through to `findSimilar*` to widen the SQL filter. */
  includeReference: boolean;
  /**
   * Final card-level filter applied after batch synthesis. `searchMemory`
   * drops any card whose derived scope is `reference` (a node only cited via
   * reference sources still surfaced from a vector hit). `searchReference`
   * inverts: keep only `reference`-derived cards.
   */
  keepScope: Scope;
}

async function searchAsCards(
  req: SearchCardsRequest,
  filter: ScopeFilter,
): Promise<SearchCardsResponse> {
  const limit = req.limit ?? DEFAULT_LIMIT;
  // The eval harness sets a substring override so the helpers run without an
  // embedding. Production always takes the embedding branch; harness skips it
  // and the substring fallback in `findSimilar*` consumes the query text.
  const useSubstringFallback = getSemanticSearchSubstringQuery() !== null;
  const similaritySource: { embedding: number[] } | { text: string } =
    useSubstringFallback
      ? { text: req.query }
      : { embedding: await embedQuery(req.query) };

  const [similarNodes, similarClaims] = await Promise.all([
    findSimilarNodes({
      userId: req.userId,
      ...similaritySource,
      limit,
      ...(req.excludeNodeTypes !== undefined && {
        excludeNodeTypes: req.excludeNodeTypes,
      }),
      minimumSimilarity: MIN_SIMILARITY,
      includeReference: filter.includeReference,
    }),
    findSimilarClaims({
      userId: req.userId,
      ...similaritySource,
      limit,
      minimumSimilarity: MIN_SIMILARITY,
      includeReference: filter.includeReference,
    }),
  ]);

  // Order cards: node-similarity hits first (most direct), then subjects of
  // claim hits, then objects of claim hits. Insertion-ordered Set preserves
  // the rank without requiring a separate rerank call.
  const orderedNodeIds = new Set<TypeId<"node">>();
  for (const node of similarNodes) orderedNodeIds.add(node.id);
  for (const claim of similarClaims) {
    orderedNodeIds.add(claim.subjectNodeId);
    if (claim.objectNodeId !== null) orderedNodeIds.add(claim.objectNodeId);
  }

  const cardMap = await getNodeCards({
    userId: req.userId,
    nodeIds: Array.from(orderedNodeIds),
  });

  const cards: NodeCard[] = [];
  for (const nodeId of orderedNodeIds) {
    const card = cardMap.get(nodeId);
    if (!card) continue;
    if (card.scope !== filter.keepScope) continue;
    cards.push(card);
    if (cards.length >= limit) break;
  }

  // Evidence: dedupe by claimId in claim-rank order. Drop hits whose subject
  // didn't survive the scope filter so the caller never sees orphan claimIds.
  const keptIds = new Set(cards.map((c) => c.nodeId));
  const evidenceSeen = new Set<TypeId<"claim">>();
  const evidence: ClaimEvidence[] = [];
  for (const claim of similarClaims) {
    if (evidenceSeen.has(claim.id)) continue;
    if (!keptIds.has(claim.subjectNodeId)) continue;
    evidenceSeen.add(claim.id);
    evidence.push({ claimId: claim.id, sourceId: claim.sourceId });
  }

  return { query: req.query, cards, evidence };
}

/**
 * Personal-scope card search. Default for chat hosts and MCP `search_memory`;
 * never returns reference-scope nodes (they live behind `searchReference`).
 */
export function searchMemory(
  req: SearchCardsRequest,
): Promise<SearchCardsResponse> {
  return searchAsCards(req, { includeReference: false, keepScope: "personal" });
}

/**
 * Reference-scope card search. Surfaces only reference-derived nodes
 * (curated/ingested documents) so reference material is never rendered as a
 * personal fact.
 */
export function searchReference(
  req: SearchCardsRequest,
): Promise<SearchCardsResponse> {
  return searchAsCards(req, { includeReference: true, keepScope: "reference" });
}
