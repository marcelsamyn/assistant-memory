/** Node operations: get, get sources, update, delete. */

import { and, eq, or, inArray, aliasedTable } from "drizzle-orm";
import {
  nodes,
  nodeMetadata,
  nodeEmbeddings,
  edges,
  sourceLinks,
  sources,
} from "~/db/schema";
import { generateEmbeddings } from "~/lib/embeddings";
import { fetchSourceIdsForNodes } from "~/lib/graph";
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

/** Update a node's label and/or description. Re-generates embedding. */
export async function updateNode(
  userId: string,
  nodeId: TypeId<"node">,
  updates: { label?: string; description?: string },
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
    nodeType: row.nodeType,
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
