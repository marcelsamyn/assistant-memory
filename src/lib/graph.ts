import {
  sql,
  eq,
  desc,
  cosineDistance,
  and,
  or,
  inArray,
  isNotNull,
  not,
  notInArray,
  aliasedTable,
} from "drizzle-orm";
import { DrizzleDB } from "~/db";
import {
  nodes,
  nodeMetadata,
  nodeEmbeddings,
  edges,
  edgeEmbeddings,
  sourceLinks,
} from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import { type NodeType, type EdgeType, NodeTypeEnum } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/** Node metadata with similarity */
interface SearchResultBase {
  similarity: number;
}

export interface NodeSearchResult extends SearchResultBase {
  id: TypeId<"node">;
  type: NodeType;
  label: string | null;
  timestamp: Date;
  description: string | null;
}

/** One-hop edge plus neighbor metadata */
export interface OneHopNode {
  id: TypeId<"node">;
  type: NodeType;
  timestamp: Date;
  label: string | null;
  description: string | null;

  edgeSourceId: TypeId<"node">;
  edgeTargetId: TypeId<"node">;
  edgeType: EdgeType;
  sourceLabel: string | null;
  targetLabel: string | null;
}

/** Node enriched with connections */
export interface NodeWithConnections extends SearchResultBase {
  id: TypeId<"node">;
  type: NodeType;
  label: string;
  description: string | null;
  timestamp: Date;
  isDirectMatch?: boolean;
  connectedTo?: TypeId<"node">[];
}

export type SimilaritySearchBase = (
  | {
      embedding: number[];
    }
  | {
      text: string;
    }
) & {
  /** Minimum similarity score (0-1) filter */
  minimumSimilarity?: number;
  limit?: number;
  userId: string;
};

/** Options for semantic search */
export type FindSimilarNodesOptions = SimilaritySearchBase & {
  /** Optional list of node types to exclude from the search results */
  excludeNodeTypes?: NodeType[];
};

/** Options for semantic search on edges */
export type FindSimilarEdgesOptions = SimilaritySearchBase;

/** Edge metadata with similarity */
export interface EdgeSearchResult {
  id: TypeId<"edge">;
  sourceNodeId: TypeId<"node">;
  targetNodeId: TypeId<"node">;
  sourceLabel: string | null;
  targetLabel: string | null;
  edgeType: EdgeType;
  description: string | null;
  similarity: number;
  timestamp: Date;
}

async function generateTextEmbedding(text: string): Promise<number[]> {
  const res = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.query",
    input: [text],
    truncate: true,
  });
  const embedding = res.data[0]?.embedding;
  if (!embedding) throw new Error("Failed to generate embedding");
  return embedding;
}

/** Semantic search via embeddings */
export async function findSimilarNodes(
  opts: FindSimilarNodesOptions,
): Promise<NodeSearchResult[]> {
  const { userId, limit = 10, minimumSimilarity, excludeNodeTypes } = opts;

  const emb =
    "embedding" in opts
      ? opts.embedding
      : await generateTextEmbedding(opts.text);
  const similarity = sql<number>`1 - (${cosineDistance(nodeEmbeddings.embedding, emb)})`;
  const db = await useDatabase();

  // Base conditions
  let whereCondition = and(
    eq(nodes.userId, userId),
    sql`${similarity} IS NOT NULL`,
  );

  // Optional similarity threshold condition
  if (minimumSimilarity != null) {
    whereCondition = and(
      whereCondition,
      sql`${similarity} >= ${minimumSimilarity}`,
    );
  }

  // Optional exclude node types condition
  if (excludeNodeTypes && excludeNodeTypes.length > 0) {
    whereCondition = and(
      whereCondition,
      notInArray(nodes.nodeType, excludeNodeTypes),
    );
  }

  return db
    .select({
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      timestamp: nodes.createdAt,
      similarity,
    })
    .from(nodeEmbeddings)
    .innerJoin(nodes, eq(nodeEmbeddings.nodeId, nodes.id))
    .innerJoin(nodeMetadata, eq(nodes.id, nodeMetadata.nodeId))
    .where(whereCondition)
    .orderBy(desc(similarity))
    .limit(limit);
}

/** Semantic search for edges via embeddings */
export async function findSimilarEdges(
  opts: FindSimilarEdgesOptions,
): Promise<EdgeSearchResult[]> {
  const { userId, limit = 10, minimumSimilarity } = opts;

  const emb =
    "embedding" in opts
      ? opts.embedding
      : await generateTextEmbedding(opts.text);
  const similarity = sql<number>`1 - (${cosineDistance(edgeEmbeddings.embedding, emb)})`;
  const db = await useDatabase();

  // Base conditions
  let whereCondition = and(
    eq(edges.userId, userId),
    sql`${similarity} IS NOT NULL`,
  );

  // Optional similarity threshold condition
  if (minimumSimilarity != null) {
    whereCondition = and(
      whereCondition,
      sql`${similarity} >= ${minimumSimilarity}`,
    );
  }

  const fromNodeMetadata = aliasedTable(nodeMetadata, "fromNodeMetadata");
  const targetNodeMetadata = aliasedTable(nodeMetadata, "targetNodeMetadata");

  return db
    .select({
      id: edges.id,
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
      sourceLabel: fromNodeMetadata.label,
      targetLabel: targetNodeMetadata.label,
      edgeType: edges.edgeType,
      description: edges.description,
      similarity,
      timestamp: edges.createdAt,
    })
    .from(edgeEmbeddings)
    .innerJoin(edges, eq(edgeEmbeddings.edgeId, edges.id))
    .leftJoin(fromNodeMetadata, eq(fromNodeMetadata.nodeId, edges.sourceNodeId))
    .leftJoin(
      targetNodeMetadata,
      eq(targetNodeMetadata.nodeId, edges.targetNodeId),
    )
    .where(whereCondition)
    .orderBy(desc(similarity))
    .limit(limit);
}

/** One-hop neighbor lookup */
export async function findOneHopNodes(
  db: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<OneHopNode[]> {
  if (nodeIds.length === 0) return [];
  const sub = db
    .select({
      sourceId: edges.sourceNodeId,
      targetId: edges.targetNodeId,
      edgeType: edges.edgeType,
      nodeId: sql<
        TypeId<"node">
      >`CASE WHEN ${inArray(edges.sourceNodeId, nodeIds)} THEN ${edges.targetNodeId} ELSE ${edges.sourceNodeId} END`.as(
        "nodeId",
      ),
    })
    .from(edges)
    .where(
      and(
        eq(edges.userId, userId),
        or(
          inArray(edges.sourceNodeId, nodeIds),
          inArray(edges.targetNodeId, nodeIds),
        ),
      ),
    )
    .as("e");

  // alias metadata for source/target labels
  const srcMeta = aliasedTable(nodeMetadata, "srcMeta");
  const tgtMeta = aliasedTable(nodeMetadata, "tgtMeta");

  return db
    .selectDistinctOn([nodes.id], {
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      timestamp: nodes.createdAt,

      edgeType: sub.edgeType,
      edgeSourceId: sub.sourceId,
      edgeTargetId: sub.targetId,
      sourceLabel: srcMeta.label,
      targetLabel: tgtMeta.label,
    })
    .from(sub)
    .innerJoin(nodes, eq(nodes.id, sub.nodeId))
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(srcMeta, eq(srcMeta.nodeId, sub.sourceId))
    .leftJoin(tgtMeta, eq(tgtMeta.nodeId, sub.targetId))
    .where(and(not(inArray(nodes.id, nodeIds)), isNotNull(nodeMetadata.label)))
    .orderBy(nodes.id)
    .limit(50);
}

/** Fetch all nodes of a given type for a user */
export async function findNodesByType(
  userId: string,
  nodeType: NodeType,
  limit = 200,
): Promise<NodeSearchResult[]> {
  const db = await useDatabase();
  return db
    .select({
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      timestamp: nodes.createdAt,
      similarity: sql<number>`1`.as("similarity"),
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodes.id, nodeMetadata.nodeId))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, nodeType),
        isNotNull(nodeMetadata.label),
      ),
    )
    .orderBy(desc(nodes.createdAt))
    .limit(limit);
}

/** Helper to fetch the Temporal day node id for a given userId and date */
export async function findDayNode(
  db: DrizzleDB,
  userId: string,
  date: string,
): Promise<TypeId<"node"> | null> {
  const [day] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        eq(nodeMetadata.label, date),
      ),
    )
    .limit(1);
  return day?.id ?? null;
}

/**
 * Batch-fetch sourceLink mappings for a set of node IDs.
 * Returns a Map from nodeId to array of source ID strings.
 */
export async function fetchSourceIdsForNodes(
  db: DrizzleDB,
  nodeIds: TypeId<"node">[],
): Promise<Map<TypeId<"node">, string[]>> {
  if (nodeIds.length === 0) return new Map();

  const rows = await db
    .select({
      nodeId: sourceLinks.nodeId,
      sourceId: sourceLinks.sourceId,
    })
    .from(sourceLinks)
    .where(inArray(sourceLinks.nodeId, nodeIds));

  const result = new Map<TypeId<"node">, string[]>();
  for (const row of rows) {
    const existing = result.get(row.nodeId);
    if (existing) {
      existing.push(row.sourceId);
    } else {
      result.set(row.nodeId, [row.sourceId]);
    }
  }
  return result;
}

/**
 * Helper to fetch all edges between a set of node IDs for a user.
 * Returns edges where both source and target are in nodeIds and both have non-null labels.
 */
export async function fetchEdgesBetweenNodeIds(
  db: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
) {
  if (nodeIds.length === 0) return [];
  const src = aliasedTable(nodeMetadata, "src");
  const tgt = aliasedTable(nodeMetadata, "tgt");
  return db
    .select({
      source: edges.sourceNodeId,
      target: edges.targetNodeId,
      edgeType: edges.edgeType,
      description: edges.description,
    })
    .from(edges)
    .innerJoin(src, eq(src.nodeId, edges.sourceNodeId))
    .innerJoin(tgt, eq(tgt.nodeId, edges.targetNodeId))
    .where(
      and(
        eq(edges.userId, userId),
        inArray(edges.sourceNodeId, nodeIds),
        inArray(edges.targetNodeId, nodeIds),
        isNotNull(src.label),
        isNotNull(tgt.label),
      ),
    );
}
