/** Edge operations: create, delete, update. */
import { and, eq, inArray } from "drizzle-orm";
import { nodes, nodeMetadata, edges, edgeEmbeddings } from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import type { EdgeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/** Generate embedding text for an edge from its endpoint labels and description. */
async function edgeEmbeddingText(
  db: Awaited<ReturnType<typeof useDatabase>>,
  sourceNodeId: TypeId<"node">,
  targetNodeId: TypeId<"node">,
  edgeType: EdgeType,
  description: string | null,
): Promise<string> {
  const [srcMeta] = await db
    .select({ label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, sourceNodeId))
    .limit(1);
  const [tgtMeta] = await db
    .select({ label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, targetNodeId))
    .limit(1);
  return `${srcMeta?.label ?? ""} ${edgeType} ${tgtMeta?.label ?? ""}: ${description ?? ""}`;
}

/** Validate that node IDs exist and belong to userId. Returns true if all valid. */
async function validateNodeOwnership(
  db: Awaited<ReturnType<typeof useDatabase>>,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<boolean> {
  const found = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)));
  return found.length === nodeIds.length;
}

/** Create a typed edge between two existing nodes. */
export async function createEdge(
  userId: string,
  sourceNodeId: TypeId<"node">,
  targetNodeId: TypeId<"node">,
  edgeType: EdgeType,
  description?: string,
): Promise<{
  id: TypeId<"edge">;
  sourceNodeId: TypeId<"node">;
  targetNodeId: TypeId<"node">;
  edgeType: EdgeType;
  description: string | null;
}> {
  const db = await useDatabase();

  if (
    !(await validateNodeOwnership(db, userId, [sourceNodeId, targetNodeId]))
  ) {
    throw new Error("One or both nodes not found");
  }

  const [inserted] = await db
    .insert(edges)
    .values({
      userId,
      sourceNodeId,
      targetNodeId,
      edgeType,
      description: description ?? null,
    })
    .returning({
      id: edges.id,
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
      edgeType: edges.edgeType,
      description: edges.description,
    });

  if (!inserted) throw new Error("Failed to create edge");

  // Generate embedding
  const embText = await edgeEmbeddingText(
    db,
    sourceNodeId,
    targetNodeId,
    edgeType,
    description ?? null,
  );
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.insert(edgeEmbeddings).values({
      edgeId: inserted.id,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return inserted;
}

/** Delete an edge by ID. */
export async function deleteEdge(
  userId: string,
  edgeId: TypeId<"edge">,
): Promise<boolean> {
  const db = await useDatabase();
  const result = await db
    .delete(edges)
    .where(and(eq(edges.id, edgeId), eq(edges.userId, userId)))
    .returning({ id: edges.id });
  return result.length > 0;
}

/** Update an edge's type, description, or endpoints. Re-generates embedding. */
export async function updateEdge(
  userId: string,
  edgeId: TypeId<"edge">,
  updates: {
    edgeType?: EdgeType;
    description?: string;
    sourceNodeId?: TypeId<"node">;
    targetNodeId?: TypeId<"node">;
  },
): Promise<{
  id: TypeId<"edge">;
  sourceNodeId: TypeId<"node">;
  targetNodeId: TypeId<"node">;
  edgeType: EdgeType;
  description: string | null;
} | null> {
  const db = await useDatabase();

  const [current] = await db
    .select({
      id: edges.id,
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
      edgeType: edges.edgeType,
      description: edges.description,
    })
    .from(edges)
    .where(and(eq(edges.id, edgeId), eq(edges.userId, userId)))
    .limit(1);

  if (!current) return null;

  // Validate new node IDs if provided
  const newNodeIds: TypeId<"node">[] = [];
  if (updates.sourceNodeId) newNodeIds.push(updates.sourceNodeId);
  if (updates.targetNodeId) newNodeIds.push(updates.targetNodeId);
  if (newNodeIds.length > 0) {
    if (!(await validateNodeOwnership(db, userId, newNodeIds))) {
      throw new Error("One or both target nodes not found");
    }
  }

  const newSourceNodeId = updates.sourceNodeId ?? current.sourceNodeId;
  const newTargetNodeId = updates.targetNodeId ?? current.targetNodeId;
  const newEdgeType = updates.edgeType ?? current.edgeType;
  const newDescription =
    updates.description !== undefined
      ? updates.description
      : current.description;

  const updateSet: Partial<{
    edgeType: EdgeType;
    description: string;
    sourceNodeId: TypeId<"node">;
    targetNodeId: TypeId<"node">;
  }> = {
    ...(updates.edgeType !== undefined && { edgeType: updates.edgeType }),
    ...(updates.description !== undefined && {
      description: updates.description,
    }),
    ...(updates.sourceNodeId !== undefined && {
      sourceNodeId: updates.sourceNodeId,
    }),
    ...(updates.targetNodeId !== undefined && {
      targetNodeId: updates.targetNodeId,
    }),
  };

  if (Object.keys(updateSet).length > 0) {
    await db.update(edges).set(updateSet).where(eq(edges.id, edgeId));
  }

  // Re-generate embedding
  const embText = await edgeEmbeddingText(
    db,
    newSourceNodeId,
    newTargetNodeId,
    newEdgeType,
    newDescription,
  );
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.delete(edgeEmbeddings).where(eq(edgeEmbeddings.edgeId, edgeId));
    await db.insert(edgeEmbeddings).values({
      edgeId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return {
    id: edgeId,
    sourceNodeId: newSourceNodeId,
    targetNodeId: newTargetNodeId,
    edgeType: newEdgeType,
    description: newDescription,
  };
}
