// src/lib/search/explicit-search.ts
/**
 * Hybrid explicit-search pipeline: runs vector + lexical retrieval for nodes
 * and claims in parallel, fuses each id space with RRF, merges into one ranked
 * SearchHit list, and hydrates source provenance. Powers `POST /search`.
 *
 * Common aliases: hybrid search, explicit search, search pipeline, runSearch.
 */
import { inArray } from "drizzle-orm";
import {
  generateTextEmbedding,
  findSimilarNodes,
  findSimilarClaims,
  findNodesByLexical,
  findClaimsByLexical,
  type NodeLexicalResult,
  type ClaimLexicalResult,
  type NodeSearchResult,
  type ClaimSearchResult,
} from "~/lib/graph";
import { reciprocalRankFusion } from "./fusion";
import { sources } from "~/db/schema";
import { useDatabase } from "~/utils/db";
import type { SourceType } from "~/types/graph";
import type { SearchHit, SearchRequest, SearchResponse } from "~/lib/schemas/search";
import type { TypeId } from "~/types/typeid";
import { z } from "zod";

export type ExplicitSearchParams = SearchRequest;

interface HitSource {
  sourceId: string;
  type: SourceType;
  title?: string | null;
  author?: string | null;
}

/** Document sources carry title/author in metadata; parse leniently. */
const docMetaSchema = z
  .object({ title: z.string().nullish(), author: z.string().nullish() })
  .partial()
  .passthrough();

export type SourceHydrator = (
  sourceIds: TypeId<"source">[],
) => Promise<Map<string, HitSource>>;

const dbHydrateSources: SourceHydrator = async (sourceIds) => {
  const map = new Map<string, HitSource>();
  if (sourceIds.length === 0) return map;
  const db = await useDatabase();
  const rows = await db
    .select({
      id: sources.id,
      type: sources.type,
      metadata: sources.metadata,
    })
    .from(sources)
    .where(inArray(sources.id, sourceIds));
  for (const row of rows) {
    const meta = docMetaSchema.safeParse(row.metadata ?? {});
    map.set(row.id, {
      sourceId: row.id,
      type: row.type,
      title: meta.success ? (meta.data.title ?? null) : null,
      author: meta.success ? (meta.data.author ?? null) : null,
    });
  }
  return map;
};

export async function explicitSearch(
  params: ExplicitSearchParams,
  hydrate: SourceHydrator = dbHydrateSources,
): Promise<SearchResponse> {
  const { userId, query, limit, scope, filters } = params;
  const includeNodeTypes = filters?.entityTypes;
  const statedBetween = filters?.statedBetween;
  const legLimit = Math.max(limit * 2, 20);

  const embedding = await generateTextEmbedding(query);

  const [vecNodes, lexNodes, vecClaims, lexClaims]: [
    NodeSearchResult[],
    NodeLexicalResult[],
    ClaimSearchResult[],
    ClaimLexicalResult[],
  ] = await Promise.all([
    findSimilarNodes({
      userId,
      embedding,
      limit: legLimit,
      scope,
      ...(includeNodeTypes ? { includeNodeTypes } : {}),
    }),
    findNodesByLexical({
      userId,
      query,
      limit: legLimit,
      scope,
      ...(includeNodeTypes ? { includeNodeTypes } : {}),
    }),
    findSimilarClaims({
      userId,
      embedding,
      limit: legLimit,
      scope,
      ...(statedBetween ? { statedBetween } : {}),
    }),
    findClaimsByLexical({
      userId,
      query,
      limit: legLimit,
      scope,
      ...(statedBetween ? { statedBetween } : {}),
    }),
  ]);

  const nodeFusion = reciprocalRankFusion([
    vecNodes.map((n) => n.id),
    lexNodes.map((n) => n.id),
  ]);
  const claimFusion = reciprocalRankFusion([
    vecClaims.map((c) => c.id),
    lexClaims.map((c) => c.id),
  ]);

  // Index rows for hit assembly. Lexical rows carry highlights; prefer them.
  const nodeById = new Map<string, NodeSearchResult | NodeLexicalResult>();
  for (const n of vecNodes) nodeById.set(n.id, n);
  for (const n of lexNodes) nodeById.set(n.id, n);
  const nodeHighlight = new Map(lexNodes.map((n) => [n.id, n.highlight]));

  const claimById = new Map<string, ClaimSearchResult | ClaimLexicalResult>();
  for (const c of vecClaims) claimById.set(c.id, c);
  for (const c of lexClaims) claimById.set(c.id, c);
  const claimHighlight = new Map(lexClaims.map((c) => [c.id, c.highlight]));

  const claimSourceIds = claimFusion
    .map((f) => claimById.get(f.id)?.sourceId)
    .filter((s): s is TypeId<"source"> => Boolean(s));
  const sourceMap = await hydrate(claimSourceIds);

  const nodeHits: SearchHit[] = nodeFusion.flatMap((f) => {
    const row = nodeById.get(f.id);
    if (!row) return [];
    return [
      {
        kind: "node",
        nodeId: row.id,
        text: row.label ?? "",
        highlight: nodeHighlight.get(row.id) ?? row.label ?? "",
        score: f.score,
        // Node provenance is a v1 placeholder (a node has many sources); the
        // UI fetches full provenance via get_entity when needed.
        source: { sourceId: "", type: "manual" },
      },
    ];
  });

  const claimHits: SearchHit[] = claimFusion.flatMap((f) => {
    const row = claimById.get(f.id);
    if (!row) return [];
    const source: HitSource = sourceMap.get(row.sourceId) ?? {
      sourceId: row.sourceId,
      type: "manual",
      title: null,
      author: null,
    };
    return [
      {
        kind: "claim",
        nodeId: row.subjectNodeId,
        claimId: row.id,
        text: row.statement,
        highlight: claimHighlight.get(row.id) ?? row.statement,
        score: f.score,
        source,
        statedAt: row.statedAt,
      },
    ];
  });

  const hits = [...nodeHits, ...claimHits]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return { query, hits };
}
