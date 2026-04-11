/** Node operations: get, get sources, update, delete. */

import { and, eq, or, inArray, aliasedTable, sql } from "drizzle-orm";
import {
  nodes,
  nodeMetadata,
  nodeEmbeddings,
  edges,
  sourceLinks,
  sources,
} from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import { fetchSourceIdsForNodes, findOneHopNodes, fetchEdgesBetweenNodeIds } from "~/lib/graph";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import type { NodeType } from "~/types/graph";
import { sourceService } from "~/lib/sources";
import type { GetNodeResponse, GetNodeSourcesResponse } from "./schemas/node";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/** Fetch a single node by ID with all its edges and source IDs. */
export async function getNodeById(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<GetNodeResponse | null> {
  const db = await useDatabase();

  const [row] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!row) return null;

  // Fetch all edges touching this node (both directions)
  const srcMeta = aliasedTable(nodeMetadata, "srcMeta");
  const tgtMeta = aliasedTable(nodeMetadata, "tgtMeta");

  const edgeRows = await db
    .select({
      id: edges.id,
      sourceNodeId: edges.sourceNodeId,
      targetNodeId: edges.targetNodeId,
      edgeType: edges.edgeType,
      description: edges.description,
      sourceLabel: srcMeta.label,
      targetLabel: tgtMeta.label,
    })
    .from(edges)
    .leftJoin(srcMeta, eq(srcMeta.nodeId, edges.sourceNodeId))
    .leftJoin(tgtMeta, eq(tgtMeta.nodeId, edges.targetNodeId))
    .where(
      and(
        eq(edges.userId, userId),
        or(eq(edges.sourceNodeId, nodeId), eq(edges.targetNodeId, nodeId)),
      ),
    );

  const sourceIdMap = await fetchSourceIdsForNodes(db, [nodeId]);

  return {
    node: {
      ...row,
      label: row.label ?? null,
      description: row.description ?? null,
      sourceIds: sourceIdMap.get(nodeId) ?? [],
    },
    edges: edgeRows,
  };
}

/** Fetch raw source content linked to a node. */
export async function getNodeSources(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<GetNodeSourcesResponse> {
  const db = await useDatabase();

  // Verify node ownership
  const [nodeRow] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!nodeRow) return { sources: [] };

  // Get linked sources
  const linkedSources = await db
    .select({
      sourceId: sources.id,
      type: sources.type,
      metadata: sources.metadata,
      timestamp: sources.lastIngestedAt,
    })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(eq(sourceLinks.nodeId, nodeId));

  if (linkedSources.length === 0) return { sources: [] };

  // Fetch raw content for each source
  const sourceIds = linkedSources.map(
    (s) => s.sourceId as TypeId<"source">,
  );
  const rawResults = await sourceService.fetchRaw(userId, sourceIds);
  const contentMap = new Map(
    rawResults.map((r) => [
      r.sourceId,
      r.kind === "inline" ? r.content : r.buffer.toString("utf-8"),
    ]),
  );

  return {
    sources: linkedSources.map((s) => ({
      sourceId: s.sourceId,
      type: s.type,
      content: contentMap.get(s.sourceId) ?? null,
      timestamp: s.timestamp,
    })),
  };
}

/** Update a node's label, description, and/or nodeType. Re-generates embedding. */
export async function updateNode(
  userId: string,
  nodeId: TypeId<"node">,
  updates: { label?: string; description?: string; nodeType?: NodeType },
): Promise<{ id: TypeId<"node">; nodeType: string; label: string | null; description: string | null } | null> {
  const db = await useDatabase();

  // Verify ownership and fetch current state
  const [row] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      metaId: nodeMetadata.id,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!row) return null;

  if (updates.nodeType !== undefined) {
    await db
      .update(nodes)
      .set({ nodeType: updates.nodeType })
      .where(eq(nodes.id, nodeId));
  }

  const effectiveNodeType = updates.nodeType ?? row.nodeType;
  const newLabel = updates.label ?? row.label;
  const newDescription = updates.description ?? row.description;

  // Update metadata
  await db
    .update(nodeMetadata)
    .set({
      ...(updates.label !== undefined ? { label: updates.label } : {}),
      ...(updates.description !== undefined
        ? { description: updates.description }
        : {}),
    })
    .where(eq(nodeMetadata.id, row.metaId));

  // Re-generate embedding if label or description changed
  if (newLabel && (updates.label !== undefined || updates.description !== undefined)) {
    const embText = `${newLabel}: ${newDescription ?? ""}`;
    const embResponse = await generateEmbeddings({
      model: "jina-embeddings-v3",
      task: "retrieval.passage",
      input: [embText],
      truncate: true,
    });
    const embedding = embResponse.data[0]?.embedding;
    if (embedding) {
      // Delete old embedding and insert new one
      await db
        .delete(nodeEmbeddings)
        .where(eq(nodeEmbeddings.nodeId, nodeId));
      await db.insert(nodeEmbeddings).values({
        nodeId,
        embedding,
        modelName: "jina-embeddings-v3",
      });
    }
  }

  return {
    id: row.id,
    nodeType: effectiveNodeType,
    label: newLabel ?? null,
    description: newDescription ?? null,
  };
}

/** Delete a node by ID. Cascading FKs handle edges, embeddings, sourceLinks. */
export async function deleteNode(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<boolean> {
  const db = await useDatabase();

  const result = await db
    .delete(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .returning({ id: nodes.id });

  return result.length > 0;
}

/** Create a new node with metadata and embedding. */
export async function createNode(
  userId: string,
  nodeType: NodeType,
  label: string,
  description?: string,
): Promise<{ id: TypeId<"node">; nodeType: NodeType; label: string; description: string | null }> {
  const db = await useDatabase();
  await ensureUser(db, userId);

  const [inserted] = await db
    .insert(nodes)
    .values({ userId, nodeType })
    .returning({ id: nodes.id });

  if (!inserted) throw new Error("Failed to create node");

  await db.insert(nodeMetadata).values({
    nodeId: inserted.id,
    label,
    description: description ?? null,
  });

  const embText = `${label}: ${description ?? ""}`;
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.insert(nodeEmbeddings).values({
      nodeId: inserted.id,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return { id: inserted.id, nodeType, label, description: description ?? null };
}

/** Merge multiple nodes into one. First node is the survivor. */
export async function mergeNodes(
  userId: string,
  nodeIds: TypeId<"node">[],
  overrides?: { targetLabel?: string; targetDescription?: string },
): Promise<{ id: TypeId<"node">; nodeType: string; label: string; description: string | null } | null> {
  const db = await useDatabase();

  const foundNodes = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)));

  if (foundNodes.length !== nodeIds.length) return null;

  const survivorId = nodeIds[0]!;
  const consumedIds = nodeIds.slice(1);
  const survivorRow = foundNodes.find((n) => n.id === survivorId)!;

  const finalLabel = overrides?.targetLabel ?? survivorRow.label ?? "";
  const finalDescription =
    overrides?.targetDescription !== undefined
      ? overrides.targetDescription
      : survivorRow.description;

  await db.transaction(async (tx) => {
    for (const consumedId of consumedIds) {
      // Re-point edges where consumed is source
      await tx.execute(sql`
        UPDATE edges
        SET source_node_id = ${survivorId}
        WHERE source_node_id = ${consumedId}
          AND user_id = ${userId}
          AND NOT EXISTS (
            SELECT 1 FROM edges e2
            WHERE e2.source_node_id = ${survivorId}
              AND e2.target_node_id = edges.target_node_id
              AND e2.edge_type = edges.edge_type
          )
      `);

      // Re-point edges where consumed is target
      await tx.execute(sql`
        UPDATE edges
        SET target_node_id = ${survivorId}
        WHERE target_node_id = ${consumedId}
          AND user_id = ${userId}
          AND NOT EXISTS (
            SELECT 1 FROM edges e2
            WHERE e2.source_node_id = edges.source_node_id
              AND e2.target_node_id = ${survivorId}
              AND e2.edge_type = edges.edge_type
          )
      `);

      // Delete remaining duplicate edges
      await tx
        .delete(edges)
        .where(
          and(
            eq(edges.userId, userId),
            or(
              eq(edges.sourceNodeId, consumedId),
              eq(edges.targetNodeId, consumedId),
            ),
          ),
        );

      // Consolidate source_links
      await tx.execute(sql`
        UPDATE source_links
        SET node_id = ${survivorId}
        WHERE node_id = ${consumedId}
          AND NOT EXISTS (
            SELECT 1 FROM source_links sl2
            WHERE sl2.node_id = ${survivorId}
              AND sl2.source_id = source_links.source_id
          )
      `);

      await tx
        .delete(sourceLinks)
        .where(eq(sourceLinks.nodeId, consumedId));
    }

    // Delete consumed nodes
    await tx
      .delete(nodes)
      .where(and(eq(nodes.userId, userId), inArray(nodes.id, consumedIds)));

    // Update survivor metadata
    await tx
      .update(nodeMetadata)
      .set({ label: finalLabel, description: finalDescription })
      .where(eq(nodeMetadata.nodeId, survivorId));

    // Delete self-referencing edges
    await tx.execute(sql`
      DELETE FROM edges
      WHERE source_node_id = ${survivorId}
        AND target_node_id = ${survivorId}
    `);
  });

  // Re-generate embedding (outside transaction — external API call)
  const embText = `${finalLabel}: ${finalDescription ?? ""}`;
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db.delete(nodeEmbeddings).where(eq(nodeEmbeddings.nodeId, survivorId));
    await db.insert(nodeEmbeddings).values({
      nodeId: survivorId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return {
    id: survivorId,
    nodeType: survivorRow.nodeType,
    label: finalLabel,
    description: finalDescription ?? null,
  };
}

/** Batch delete nodes in a single query. */
export async function batchDeleteNodes(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<number> {
  const db = await useDatabase();
  const result = await db
    .delete(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)))
    .returning({ id: nodes.id });
  return result.length;
}

/** Get ego-graph neighborhood around a focal node. */
export async function getNodeNeighborhood(
  userId: string,
  nodeId: TypeId<"node">,
  depth: 1 | 2 = 1,
): Promise<{
  nodes: { id: TypeId<"node">; nodeType: string; label: string; description: string | null; sourceIds: string[] }[];
  edges: { source: TypeId<"node">; target: TypeId<"node">; edgeType: string; description: string | null }[];
} | null> {
  const db = await useDatabase();

  const [focal] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!focal) return null;

  const allNodeIds = new Set<TypeId<"node">>([nodeId]);
  const nodeMap = new Map<
    TypeId<"node">,
    { id: TypeId<"node">; nodeType: string; label: string; description: string | null }
  >();
  nodeMap.set(nodeId, {
    id: focal.id,
    nodeType: focal.nodeType,
    label: focal.label ?? "",
    description: focal.description,
  });

  const hop1 = await findOneHopNodes(db, userId, [nodeId]);
  for (const n of hop1) {
    if (!allNodeIds.has(n.id)) {
      allNodeIds.add(n.id);
      nodeMap.set(n.id, {
        id: n.id,
        nodeType: n.type,
        label: n.label ?? "",
        description: n.description,
      });
    }
  }

  if (depth === 2) {
    const hop1Ids = hop1.map((n) => n.id).filter((id) => id !== nodeId);
    if (hop1Ids.length > 0) {
      const hop2 = await findOneHopNodes(db, userId, hop1Ids);
      for (const n of hop2) {
        if (!allNodeIds.has(n.id)) {
          allNodeIds.add(n.id);
          nodeMap.set(n.id, {
            id: n.id,
            nodeType: n.type,
            label: n.label ?? "",
            description: n.description,
          });
        }
      }
    }
  }

  const ids = Array.from(allNodeIds);
  const [edgeRows, sourceIdMap] = await Promise.all([
    fetchEdgesBetweenNodeIds(db, userId, ids),
    fetchSourceIdsForNodes(db, ids),
  ]);

  return {
    nodes: Array.from(nodeMap.values()).map((n) => ({
      ...n,
      sourceIds: sourceIdMap.get(n.id) ?? [],
    })),
    edges: edgeRows,
  };
}
