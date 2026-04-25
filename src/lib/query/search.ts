import { generateEmbeddings } from "../embeddings";
import {
  findOneHopNodes,
  findSimilarClaims,
  findSimilarNodes,
  fetchSourceIdsForNodes,
} from "../graph";
import { rerankMultiple } from "../rerank";
import {
  QuerySearchRequest,
  QuerySearchResponse,
} from "../schemas/query-search";
import { useDatabase } from "~/utils/db";

/**
 * Search stored memories based on a query string.
 */
export async function searchMemory(
  params: QuerySearchRequest,
): Promise<Pick<QuerySearchResponse, "query" | "searchResults">> {
  const { userId, query, limit, excludeNodeTypes } = params;
  const db = await useDatabase();

  const embeddingsResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.query",
    input: [query],
    truncate: true,
  });
  const embedding = embeddingsResponse.data[0]?.embedding;
  if (!embedding) throw new Error("Failed to generate embedding");

  const [similarNodes, similarClaims] = await Promise.all([
    findSimilarNodes({
      userId,
      embedding,
      limit,
      excludeNodeTypes,
      minimumSimilarity: 0.4,
    }),
    findSimilarClaims({
      userId,
      embedding,
      limit,
      minimumSimilarity: 0.4,
    }),
  ]);

  const nodeIds = new Set([
    ...similarNodes.map((node) => node.id),
    ...similarClaims.flatMap((claim) =>
      claim.objectNodeId
        ? [claim.subjectNodeId, claim.objectNodeId]
        : [claim.subjectNodeId],
    ),
  ]);

  const connections = await findOneHopNodes(db, userId, Array.from(nodeIds));

  // Collect all node IDs to batch-fetch sourceIds
  const allNodeIds = [
    ...similarNodes.map((n) => n.id),
    ...connections.map((c) => c.id),
  ];
  const sourceIdMap = await fetchSourceIdsForNodes(db, allNodeIds);

  // Attach sourceIds to nodes and connections
  const similarNodesWithSources = similarNodes.map((n) => ({
    ...n,
    sourceIds: sourceIdMap.get(n.id) ?? [],
  }));
  const connectionsWithSources = connections.map((c) => ({
    ...c,
    sourceIds: sourceIdMap.get(c.id) ?? [],
  }));

  const rerankedResults = await rerankMultiple(
    query,
    {
      similarNodes: {
        items: similarNodesWithSources,
        toDocument: (n) => `${n.label}: ${n.description}`,
      },
      similarClaims: {
        items: similarClaims,
        toDocument: (e) => `${e.predicate}: ${e.statement}`,
      },
      connections: {
        items: connectionsWithSources,
        toDocument: (c) => `${c.label}: ${c.description}`,
      },
    },
    limit,
  );

  return {
    query,
    searchResults: rerankedResults,
  };
}
