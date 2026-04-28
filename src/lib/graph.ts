import {
  sql,
  eq,
  desc,
  cosineDistance,
  and,
  gt,
  or,
  inArray,
  isNull,
  isNotNull,
  not,
  notInArray,
  aliasedTable,
  ne,
  type SQL,
} from "drizzle-orm";
import { DrizzleDB } from "~/db";
import {
  nodes,
  nodeMetadata,
  nodeEmbeddings,
  claims,
  claimEmbeddings,
  sourceLinks,
  sources,
} from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import {
  type AssertedByKind,
  type ClaimStatus,
  type NodeType,
  type Predicate,
  NodeTypeEnum,
  type Scope,
} from "~/types/graph";
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

  claimSubjectId: TypeId<"node">;
  claimObjectId: TypeId<"node">;
  predicate: Predicate;
  statement: string;
  subjectLabel: string | null;
  objectLabel: string | null;
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
  includeReference?: boolean;
};

/** Options for semantic search on claims */
export type FindSimilarClaimsOptions = SimilaritySearchBase & {
  statuses?: ClaimStatus[];
  asOf?: Date;
  includeReference?: boolean;
  includeAssistantInferred?: boolean;
};

/** Claim metadata with similarity */
export interface ClaimSearchResult {
  id: TypeId<"claim">;
  subjectNodeId: TypeId<"node">;
  objectNodeId: TypeId<"node"> | null;
  objectValue: string | null;
  subjectLabel: string | null;
  objectLabel: string | null;
  predicate: Predicate;
  statement: string;
  description: string | null;
  sourceId: TypeId<"source">;
  scope: Scope;
  assertedByKind: AssertedByKind;
  assertedByNodeId: TypeId<"node"> | null;
  status: ClaimStatus;
  statedAt: Date;
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

function nodeHasScopeSupport(userId: string, scope: Scope): SQL<boolean> {
  return sql<boolean>`(
    EXISTS (
      SELECT 1
      FROM ${sourceLinks}
      INNER JOIN ${sources} ON ${sources.id} = ${sourceLinks.sourceId}
      WHERE ${sourceLinks.nodeId} = ${nodes.id}
        AND ${sources.userId} = ${userId}
        AND ${sources.scope} = ${scope}
    )
    OR EXISTS (
      SELECT 1
      FROM ${claims}
      WHERE ${claims.userId} = ${userId}
        AND ${claims.scope} = ${scope}
        AND ${claims.status} = 'active'
        AND (
          ${claims.subjectNodeId} = ${nodes.id}
          OR ${claims.objectNodeId} = ${nodes.id}
        )
    )
  )`;
}

/** Semantic search via embeddings */
export async function findSimilarNodes(
  opts: FindSimilarNodesOptions,
): Promise<NodeSearchResult[]> {
  const {
    userId,
    limit = 10,
    minimumSimilarity,
    excludeNodeTypes,
    includeReference = false,
  } = opts;

  const emb =
    "embedding" in opts
      ? opts.embedding
      : await generateTextEmbedding(opts.text);
  const similarity = sql<number>`1 - (${cosineDistance(nodeEmbeddings.embedding, emb)})`;
  const db = await useDatabase();

  // Base conditions
  let whereCondition = and(
    eq(nodes.userId, userId),
    includeReference ? undefined : nodeHasScopeSupport(userId, "personal"),
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

/** Semantic search for claims via embeddings */
export async function findSimilarClaims(
  opts: FindSimilarClaimsOptions,
): Promise<ClaimSearchResult[]> {
  const {
    userId,
    limit = 10,
    minimumSimilarity,
    statuses = ["active"],
    asOf = new Date(),
    includeReference = false,
    includeAssistantInferred = false,
  } = opts;

  const emb =
    "embedding" in opts
      ? opts.embedding
      : await generateTextEmbedding(opts.text);
  const similarity = sql<number>`1 - (${cosineDistance(claimEmbeddings.embedding, emb)})`;
  const db = await useDatabase();

  // Base conditions
  let whereCondition = and(
    eq(claims.userId, userId),
    includeReference ? undefined : eq(claims.scope, "personal"),
    includeAssistantInferred
      ? undefined
      : ne(claims.assertedByKind, "assistant_inferred"),
    inArray(claims.status, statuses),
    or(isNull(claims.validTo), gt(claims.validTo, asOf)),
    sql`${similarity} IS NOT NULL`,
  );

  // Optional similarity threshold condition
  if (minimumSimilarity != null) {
    whereCondition = and(
      whereCondition,
      sql`${similarity} >= ${minimumSimilarity}`,
    );
  }

  const subjectNodeMetadata = aliasedTable(nodeMetadata, "subjectNodeMetadata");
  const objectNodeMetadata = aliasedTable(nodeMetadata, "objectNodeMetadata");

  return db
    .select({
      id: claims.id,
      subjectNodeId: claims.subjectNodeId,
      objectNodeId: claims.objectNodeId,
      objectValue: claims.objectValue,
      subjectLabel: subjectNodeMetadata.label,
      objectLabel: objectNodeMetadata.label,
      predicate: claims.predicate,
      statement: claims.statement,
      description: claims.description,
      sourceId: claims.sourceId,
      scope: claims.scope,
      assertedByKind: claims.assertedByKind,
      assertedByNodeId: claims.assertedByNodeId,
      status: claims.status,
      statedAt: claims.statedAt,
      similarity,
      timestamp: claims.createdAt,
    })
    .from(claimEmbeddings)
    .innerJoin(claims, eq(claimEmbeddings.claimId, claims.id))
    .leftJoin(
      subjectNodeMetadata,
      eq(subjectNodeMetadata.nodeId, claims.subjectNodeId),
    )
    .leftJoin(
      objectNodeMetadata,
      eq(objectNodeMetadata.nodeId, claims.objectNodeId),
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
  options: {
    includeReference?: boolean;
    includeAssistantInferred?: boolean;
  } = {},
): Promise<OneHopNode[]> {
  if (nodeIds.length === 0) return [];
  const { includeReference = false, includeAssistantInferred = false } =
    options;
  const sub = db
    .select({
      subjectId: claims.subjectNodeId,
      objectId: sql<TypeId<"node">>`${claims.objectNodeId}`.as("objectId"),
      predicate: claims.predicate,
      statement: claims.statement,
      nodeId: sql<
        TypeId<"node">
      >`CASE WHEN ${inArray(claims.subjectNodeId, nodeIds)} THEN ${claims.objectNodeId} ELSE ${claims.subjectNodeId} END`.as(
        "nodeId",
      ),
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        includeReference ? undefined : eq(claims.scope, "personal"),
        includeAssistantInferred
          ? undefined
          : ne(claims.assertedByKind, "assistant_inferred"),
        eq(claims.status, "active"),
        isNotNull(claims.objectNodeId),
        or(
          inArray(claims.subjectNodeId, nodeIds),
          inArray(claims.objectNodeId, nodeIds),
        ),
      ),
    )
    .as("e");

  // alias metadata for subject/object labels
  const srcMeta = aliasedTable(nodeMetadata, "srcMeta");
  const tgtMeta = aliasedTable(nodeMetadata, "tgtMeta");

  return db
    .selectDistinctOn([nodes.id], {
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      timestamp: nodes.createdAt,

      predicate: sub.predicate,
      statement: sub.statement,
      claimSubjectId: sub.subjectId,
      claimObjectId: sub.objectId,
      subjectLabel: srcMeta.label,
      objectLabel: tgtMeta.label,
    })
    .from(sub)
    .innerJoin(nodes, eq(nodes.id, sub.nodeId))
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(srcMeta, eq(srcMeta.nodeId, sub.subjectId))
    .leftJoin(tgtMeta, eq(tgtMeta.nodeId, sub.objectId))
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
 * Helper to fetch all relationship claims between a set of node IDs for a user.
 * Returns claims where both subject and object are in nodeIds and both have non-null labels.
 */
export async function fetchClaimsBetweenNodeIds(
  db: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
) {
  if (nodeIds.length === 0) return [];
  const src = aliasedTable(nodeMetadata, "src");
  const tgt = aliasedTable(nodeMetadata, "tgt");
  return db
    .select({
      id: claims.id,
      subject: claims.subjectNodeId,
      object: sql<TypeId<"node">>`${claims.objectNodeId}`.as("object"),
      predicate: claims.predicate,
      statement: claims.statement,
      description: claims.description,
      sourceId: claims.sourceId,
      scope: claims.scope,
      assertedByKind: claims.assertedByKind,
      assertedByNodeId: claims.assertedByNodeId,
      statedAt: claims.statedAt,
      status: claims.status,
    })
    .from(claims)
    .innerJoin(src, eq(src.nodeId, claims.subjectNodeId))
    .innerJoin(tgt, eq(tgt.nodeId, claims.objectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        inArray(claims.subjectNodeId, nodeIds),
        inArray(claims.objectNodeId, nodeIds),
        isNotNull(src.label),
        isNotNull(tgt.label),
      ),
    );
}
