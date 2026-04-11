import { createCompletionClient } from "../ai";
import {
  generateAndInsertNodeEmbeddings,
  generateAndInsertEdgeEmbeddings,
  type EmbeddableEdge,
} from "../embeddings-util";
import { findOneHopNodes, findSimilarNodes } from "../graph";
import { normalizeLabel } from "../label";
import { TemporaryIdMapper } from "../temporary-id-mapper";
import { sql, eq, gte, desc, and, inArray } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import {
  nodes,
  edges,
  nodeMetadata,
  sourceLinks,
  nodeEmbeddings,
} from "~/db/schema";
import { EdgeTypeEnum, NodeTypeEnum } from "~/types/graph";
import type { EdgeType, NodeType } from "~/types/graph";
import { TypeId, typeIdSchema } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export const CleanupGraphJobInputSchema = z.object({
  userId: z.string(),
  since: z.coerce.date(),
  entryNodeLimit: z.number().int().positive().default(5),
  semanticNeighborLimit: z.number().int().positive().default(15),
  graphHopDepth: z.union([z.literal(1), z.literal(2)]).default(2),
  maxSubgraphNodes: z.number().int().positive().default(100),
  maxSubgraphEdges: z.number().int().positive().default(150),
  llmModelId: z.string(),
  seedIds: z
    .array(typeIdSchema("node"))
    .optional()
    .describe("Optional manual seed node IDs"),
});

/**
 * Parameters for cleanup job
 */
export type CleanupGraphParams = z.infer<typeof CleanupGraphJobInputSchema>;

/**
 * Core graph types
 */
export interface GraphNode {
  id: TypeId<"node">;
  label: string;
  description: string;
  type: NodeType;
}

/**
 * Core graph types
 */
export interface GraphEdge {
  source: TypeId<"node">;
  target: TypeId<"node">;
  type: EdgeType;
  description?: string;
}
export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Temporary graph for LLM
 */
export interface TempNode extends GraphNode {
  tempId: string;
}
export interface TempEdge {
  sourceTemp: string;
  targetTemp: string;
  type: EdgeType;
  description: string;
}
export interface TempSubgraph {
  nodes: TempNode[];
  edges: TempEdge[];
}

export const CleanupProposalSchema = z.object({
  merges: z
    .array(
      z.object({
        keep: z.string().describe("Temp ID of node to keep"),
        remove: z.string().describe("Temp ID of node to merge/remove"),
      }),
    )
    .describe(
      "Pairs of temp node IDs to merge (remove into keep); use for nodes that are duplicates or should be merged",
    ),
  deletes: z
    .array(
      z.object({
        tempId: z.string().describe("Temp ID of node to delete"),
      }),
    )
    .describe("Temp node IDs to delete (if completely irrelevant)"),
  additions: z
    .array(
      z.object({
        source: z.string().describe("Temp ID of source node"),
        target: z.string().describe("Temp ID of target node"),
        type: EdgeTypeEnum.describe("Type of edge"),
        description: z
          .string()
          .describe("Concise description of the edge's meaning"),
      }),
    )
    .describe("New edges to add"),
  newNodes: z
    .array(
      z.object({
        tempId: z.string().describe("Temp ID for new node"),
        label: z.string().describe("Label for new node"),
        description: z.string().describe("Description for new node"),
        type: NodeTypeEnum.describe("Type of new node"),
      }),
    )
    .describe("New nodes to create"),
});

/**
 * Cleanup proposal from LLM
 */
export type CleanupProposal = z.infer<typeof CleanupProposalSchema>;

/**
 * Detailed result of cleanup execution
 */
export interface CleanupGraphResult {
  merged: Array<{
    keep: TypeId<"node">;
    keepLabel: string;
    keepDescription?: string;
    remove: TypeId<"node">;
    removeLabel: string;
    removeDescription?: string;
  }>;
  removed: Array<{
    nodeId: TypeId<"node">;
    label: string;
    description?: string;
  }>;
  addedEdges: Array<{
    source: TypeId<"node">;
    target: TypeId<"node">;
    type: EdgeType;
  }>;
  createdNodes: Array<{
    nodeId: TypeId<"node">;
    label: string;
    description?: string;
  }>;
}

/**
 * Params for one cleanup iteration with explicit seeds
 */
export interface CleanupGraphIterationParams extends CleanupGraphParams {
  seedIds: TypeId<"node">[];
  /** Minimum nodes required in subgraph to proceed (default 5) */
  minSubgraphNodes?: number;
}

/**
 * Core single-iteration cleanup: builds subgraph from seedIds and applies LLM proposal
 */
export async function cleanupGraphIteration(
  params: CleanupGraphIterationParams,
): Promise<CleanupGraphResult | null> {
  const {
    userId,
    seedIds,
    semanticNeighborLimit,
    graphHopDepth,
    maxSubgraphNodes,
    maxSubgraphEdges,
    llmModelId,
    minSubgraphNodes = 5,
  } = params;
  // 1. build subgraph from provided seeds
  const sub = await buildSubgraph(
    userId,
    seedIds,
    semanticNeighborLimit,
    graphHopDepth,
    maxSubgraphNodes,
    maxSubgraphEdges,
  );
  if (sub.nodes.length < minSubgraphNodes) {
    console.debug(
      `[cleanup-iter] Subgraph too small (${sub.nodes.length} < ${minSubgraphNodes}); skipping iteration`,
    );
    return null;
  }
  // 2. map to temporary IDs
  const { tempSubgraph, mapper } = toTempSubgraph(sub);
  // 3. propose cleanup via LLM
  const proposal = await proposeGraphCleanup(userId, tempSubgraph, llmModelId);
  // 4. apply proposal to DB
  const db = await useDatabase();
  const result = await applyCleanupProposal(proposal, mapper, db, userId);
  // 5. log summary and return
  logCleanupSummary(params, result);
  return result;
}

/**
 * Step 1: select entry nodes
 */
export async function fetchEntryNodes(
  userId: string,
  since: Date,
  limit: number,
): Promise<TypeId<"node">[]> {
  // Select nodes with highest edge count since given date
  const db = await useDatabase();
  const rows = await db
    .select({
      nodeId: edges.sourceNodeId,
      count: sql<number>`COUNT(*)`.as("count"),
    })
    .from(edges)
    .where(and(eq(edges.userId, userId), gte(edges.createdAt, since)))
    .groupBy(edges.sourceNodeId)
    .orderBy(desc(sql`count`))
    .limit(limit);
  return rows.map((r) => r.nodeId);
}

/**
 * Step 2: expand to a subgraph
 */
async function buildSubgraph(
  userId: string,
  seedIds: TypeId<"node">[],
  semanticLimit: number,
  hopDepth: number,
  maxNodes: number,
  maxEdges: number,
): Promise<Subgraph> {
  const db = await useDatabase();
  // load seed metadata
  const seedMetaRows = await db
    .select({
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(inArray(nodes.id, seedIds));
  // store nodes in insertion order
  const nodeMap = new Map<TypeId<"node">, GraphNode>();
  for (const r of seedMetaRows) {
    nodeMap.set(r.id, {
      id: r.id,
      label: r.label ?? "",
      description: r.description ?? "",
      type: r.type,
    });
  }
  // semantic neighbors (run in parallel)
  const seeds = Array.from(nodeMap.values());
  const neighborResults = await Promise.all(
    seeds.map((seed) =>
      findSimilarNodes({
        userId,
        text: `${seed.label}: ${seed.description}`,
        limit: semanticLimit,
        minimumSimilarity: 0.5,
      }),
    ),
  );
  for (const neighbors of neighborResults) {
    for (const n of neighbors) {
      if (!nodeMap.has(n.id)) {
        nodeMap.set(n.id, {
          id: n.id,
          label: n.label ?? "",
          description: n.description ?? "",
          type: n.type,
        });
      }
    }
  }
  const edgesList: GraphEdge[] = [];
  // Expand connections
  let currentIds = Array.from(nodeMap.keys());
  for (let hop = 1; hop <= hopDepth; hop++) {
    const conns = await findOneHopNodes(db, userId, currentIds);
    const nextIds: typeof currentIds = [];
    for (const c of conns) {
      if (!nodeMap.has(c.id)) {
        nodeMap.set(c.id, {
          id: c.id,
          label: c.label ?? "",
          description: c.description ?? "",
          type: c.type,
        });
        nextIds.push(c.id);
      }
      edgesList.push({
        source: c.edgeSourceId,
        target: c.edgeTargetId,
        type: c.edgeType,
        description: c.description ?? "",
      });
    }
    currentIds = nextIds;
    if (!currentIds.length) break;
  }
  // dedupe edges
  const unique: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edgesList) {
    const key = `${e.source}|${e.target}|${e.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }
  // trim nodes & edges, ensuring edges only reference kept nodes
  const nodesArr = Array.from(nodeMap.values()).slice(0, maxNodes);
  const nodeIdsSet = new Set(nodesArr.map((n) => n.id));
  const edgesArr = unique
    .filter((e) => nodeIdsSet.has(e.source) && nodeIdsSet.has(e.target))
    .slice(0, maxEdges);
  return { nodes: nodesArr, edges: edgesArr };
}

/**
 * Step 3: map to temporary IDs for LLM
 */
function toTempSubgraph(sub: Subgraph): {
  tempSubgraph: TempSubgraph;
  mapper: TemporaryIdMapper<GraphNode, string>;
} {
  const mapper = new TemporaryIdMapper<GraphNode, string>(
    (_item, idx) => `temp_node_${idx + 1}`,
  );
  const tempNodes = mapper.mapItems(sub.nodes);
  const tempEdges: TempEdge[] = sub.edges.map((e) => {
    const src = sub.nodes.find((n) => n.id === e.source)!;
    const tgt = sub.nodes.find((n) => n.id === e.target)!;
    return {
      sourceTemp: mapper.getId(src)!,
      targetTemp: mapper.getId(tgt)!,
      type: e.type,
      description: e.description ?? "",
    };
  });
  return { tempSubgraph: { nodes: tempNodes, edges: tempEdges }, mapper };
}

/**
 * Step 4: get cleanup proposal from LLM
 */
async function proposeGraphCleanup(
  userId: string,
  temp: TempSubgraph,
  modelId: string,
): Promise<CleanupProposal> {
  const client = await createCompletionClient(userId);

  // Fetch user atlas for context about user corrections and current state
  const { getAtlas } = await import("../atlas");
  const db = await useDatabase();
  const { description: userAtlas } = await getAtlas(db, userId);

  const nodesList = temp.nodes
    .map(
      (n) =>
        `<node tempId="${n.tempId}" label="${n.label}" type="${n.type}">${n.description}</node>`,
    )
    .join("\n");
  const edgesList = temp.edges
    .map(
      (e) =>
        `<edge source="${e.sourceTemp}" target="${e.targetTemp}" type="${e.type}">${e.description}</edge>`,
    )
    .join("\n");
  const prompt = `You are a graph cleaning assistant. Your task is to analyze this subgraph and propose improvements to ensure accuracy, remove redundancies, and maintain data quality.
${
  userAtlas
    ? `
**User Atlas Context:**
The following is the current User Atlas, which represents the most up-to-date factual information about the user. Use this to identify any nodes in the graph that contradict or are outdated compared to the atlas.

<user_atlas>
${userAtlas}
</user_atlas>
`
    : ""
}

**Critical Cleaning Rules:**

1. **Check Against User Atlas**: If a User Atlas is provided above, use it as the source of truth:
   - Delete any nodes that contradict information in the atlas
   - Remove nodes that represent outdated information superseded by the atlas
   - The atlas reflects user corrections and the most current factual information

2. **Remove Redundant Nodes**: Identify and merge nodes that represent the same entity or concept. Look for:
   - Duplicate entities with slightly different labels (e.g., "John Smith" and "John")
   - Multiple nodes describing the same event or concept
   - Nodes that could be consolidated without losing information

3. **Delete Incorrect or Speculative Information**: Remove nodes that represent:
   - Speculative or assumed information (not explicitly stated facts)
   - Outdated information that has been superseded or contradicted
   - Unclear or non-useful nodes with vague descriptions
   - Nodes that don't represent factual information about the user

4. **Identify Contradictions**: When you find contradicting information:
   - Keep the most recent or most specific information
   - Delete older or vaguer contradicting nodes
   - Prefer user-stated facts over inferred information
   - Always prefer atlas information over graph nodes when they conflict

5. **Improve Connections**: Add missing edges between related nodes that should be connected

6. **Remove Redundant Edges**: Don't create edges that duplicate existing relationships

**Your Response Should Include:**
- **merges**: Pairs of temp IDs where nodes are duplicates (remove will be merged into keep)
- **deletes**: Temp IDs of nodes to completely remove (speculative, outdated, or unclear)
- **additions**: New edges to add (with concise, factual descriptions)
- **newNodes**: Any new nodes needed (only if genuinely missing and factual)

**Important**: Be aggressive about removing redundant and speculative information. Quality and accuracy are more important than quantity.

Nodes:
${nodesList}

Edges:
${edgesList}
`;
  const completion = await client.beta.chat.completions.parse({
    messages: [{ role: "user", content: prompt }],
    model: modelId,
    response_format: zodResponseFormat(
      CleanupProposalSchema,
      "CleanupProposal",
    ),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("Failed to parse cleanup proposal");
  return parsed;
}

/**
 * Step 5: apply cleanup operations
 */
async function applyCleanupProposal(
  proposal: CleanupProposal,
  mapper: TemporaryIdMapper<GraphNode, string>,
  db: Awaited<ReturnType<typeof useDatabase>>,
  userId: string,
): Promise<CleanupGraphResult> {
  return db.transaction(async (tx) => {
    const merged: CleanupGraphResult["merged"] = [];
    const removed: CleanupGraphResult["removed"] = [];
    const addedEdgesResult: CleanupGraphResult["addedEdges"] = [];
    const createdNodes: Array<
      CleanupGraphResult["createdNodes"][number] & { tempId?: string }
    > = [];

    // Preprocessing: remap temp IDs for merges
    const remap = new Map<string, string>();
    for (const { keep, remove } of proposal.merges) {
      remap.set(remove, keep);
    }
    // Rewrite deletes with remapped IDs and dedupe
    const newDeletes = Array.from(
      new Set(proposal.deletes.map((d) => remap.get(d.tempId) ?? d.tempId)),
    ).map((tempId) => ({ tempId }));
    // Rewrite additions with remapped IDs, drop self-edges
    const newEdgesToCreate = proposal.additions
      .map(({ source, target, type, description }) => ({
        source: remap.get(source) ?? source,
        target: remap.get(target) ?? target,
        type,
        description,
      }))
      .filter((e) => e.source !== e.target);
    // Keep newNodes as-is
    const newNodesToCreate = [...proposal.newNodes];

    // Step 1: Create new nodes
    for (const n of newNodesToCreate) {
      const inserted = await tx
        .insert(nodes)
        .values({ userId, nodeType: n.type })
        .returning({ id: nodes.id });
      const nodeId = inserted[0]?.id;
      if (!nodeId) continue;
      await tx.insert(nodeMetadata).values({
        nodeId,
        label: n.label,
        canonicalLabel: normalizeLabel(n.label),
        description: n.description,
      });
      createdNodes.push({
        nodeId,
        label: n.label,
        description: n.description,
        tempId: n.tempId,
      });
    }

    // Step 2: Merges
    for (const m of proposal.merges) {
      const keepNode = mapper.getItem(m.keep);
      const removeNode = mapper.getItem(m.remove);
      if (!keepNode || !removeNode) continue;
      const keepId = keepNode.id;
      const removeId = removeNode.id;
      await rewireNodeEdges(tx, removeId, keepId, userId);
      await rewireSourceLinks(tx, removeId, keepId);
      await deleteNode(tx, removeId, userId);
      merged.push({
        keep: keepId,
        keepLabel: keepNode.label,
        keepDescription: keepNode.description,
        remove: removeId,
        removeLabel: removeNode.label,
        removeDescription: removeNode.description,
      });
    }

    // Step 3: Additions (new edges)
    const edgeInserts: Array<typeof edges.$inferInsert> = [];
    for (const e of newEdgesToCreate) {
      const srcNodeOriginal = mapper.getItem(e.source);
      const tgtNodeOriginal = mapper.getItem(e.target);

      const srcNodeNew = createdNodes.find((cn) => cn.tempId === e.source);
      const tgtNodeNew = createdNodes.find((cn) => cn.tempId === e.target);

      const srcId = srcNodeOriginal?.id ?? srcNodeNew?.nodeId;
      const tgtId = tgtNodeOriginal?.id ?? tgtNodeNew?.nodeId;

      if (!srcId || !tgtId) {
        console.warn(
          `Skipping edge creation due to missing node mapping: ${e.source} -> ${e.target}`,
        );
        continue;
      }
      edgeInserts.push({
        userId,
        sourceNodeId: srcId,
        targetNodeId: tgtId,
        edgeType: e.type,
        description: e.description,
        metadata: {},
      });
    }

    let insertedEdgeRecords: Array<typeof edges.$inferSelect> = [];
    if (edgeInserts.length > 0) {
      insertedEdgeRecords = await tx
        .insert(edges)
        .values(edgeInserts)
        .onConflictDoNothing({
          target: [edges.sourceNodeId, edges.targetNodeId, edges.edgeType],
        })
        .returning();

      for (const r of insertedEdgeRecords) {
        addedEdgesResult.push({
          source: r.sourceNodeId,
          target: r.targetNodeId,
          type: r.edgeType,
        });
      }
    }

    // Step 4: Deletes
    for (const d of newDeletes) {
      const nodeToDelete = mapper.getItem(d.tempId);
      if (!nodeToDelete) continue;

      // Check if this node was supposed to be kept from a merge operation
      // If so, it means the LLM decided to merge AND delete the same original node which doesn't make sense.
      // Or, it's trying to delete a newly created node (which also doesn't make sense if it just created it).
      // For now, we'll prioritize merge instructions. If a node is a 'keep' in a merge, don't delete it.
      const isKeepNodeInMerge = proposal.merges.some(
        (m) => m.keep === d.tempId,
      );
      if (isKeepNodeInMerge) {
        console.warn(
          `Attempted to delete node ${d.tempId} (${nodeToDelete.label}) which was also marked as 'keep' in a merge. Skipping delete.`,
        );
        continue;
      }

      await deleteNode(tx, nodeToDelete.id, userId);
      removed.push({
        nodeId: nodeToDelete.id,
        label: nodeToDelete.label,
        description: nodeToDelete.description,
      });
    }

    // Step 5: Generate embeddings for new nodes and edges
    const newNodesLookup = new Map(
      createdNodes.map((n) => [
        n.nodeId,
        { label: n.label, description: n.description },
      ]),
    );

    // Run embedding generation concurrently
    await Promise.all([
      // Generate and insert edge embeddings
      generateAndInsertEdgeEmbeddings(
        tx,
        insertedEdgeRecords
          .map(
            (edgeRecord: typeof edges.$inferSelect): EmbeddableEdge | null => {
              const sourceNodeMappedEntry = mapper
                .entries()
                .find(
                  ({ item }: { item: GraphNode }) =>
                    item.id === edgeRecord.sourceNodeId,
                );
              const targetNodeMappedEntry = mapper
                .entries()
                .find(
                  ({ item }: { item: GraphNode }) =>
                    item.id === edgeRecord.targetNodeId,
                );
              const sourceNodeOriginal = sourceNodeMappedEntry?.item;
              const targetNodeOriginal = targetNodeMappedEntry?.item;

              const sourceLabel =
                sourceNodeOriginal?.label ??
                newNodesLookup.get(edgeRecord.sourceNodeId)?.label;
              const targetLabel =
                targetNodeOriginal?.label ??
                newNodesLookup.get(edgeRecord.targetNodeId)?.label;

              if (!sourceLabel || !targetLabel) {
                console.warn(
                  `Skipping embedding for edge ${edgeRecord.id}: missing label or description is not a string.`,
                );
                return null;
              }

              return {
                edgeId: edgeRecord.id,
                edgeType: edgeRecord.edgeType,
                description: edgeRecord.description,
                sourceLabel,
                targetLabel,
              };
            },
          )
          .filter((e): e is EmbeddableEdge => e !== null),
      ),
      // Generate and insert node embeddings
      generateAndInsertNodeEmbeddings(
        tx,
        createdNodes.map((n) => ({
          id: n.nodeId,
          label: n.label,
          description: n.description,
        })),
      ),
    ]);

    // Return structured result
    return {
      merged,
      removed,
      addedEdges: addedEdgesResult,
      createdNodes: createdNodes,
    };
  });
}

/**
 * Rewire edges from removeId to keepId for a given user
 */
export async function rewireNodeEdges(
  tx: DrizzleDB,
  removeId: TypeId<"node">,
  keepId: TypeId<"node">,
  userId: string,
) {
  // Out-going edges
  const outEdges = await tx
    .select()
    .from(edges)
    .where(and(eq(edges.sourceNodeId, removeId), eq(edges.userId, userId)));
  for (const edge of outEdges) {
    await tx
      .insert(edges)
      .values({
        userId: edge.userId,
        sourceNodeId: keepId,
        targetNodeId: edge.targetNodeId,
        edgeType: edge.edgeType,
        metadata: edge.metadata,
      })
      .onConflictDoNothing({
        target: [edges.sourceNodeId, edges.targetNodeId, edges.edgeType],
      });
  }
  await tx
    .delete(edges)
    .where(and(eq(edges.sourceNodeId, removeId), eq(edges.userId, userId)));
  // In-coming edges
  const inEdges = await tx
    .select()
    .from(edges)
    .where(and(eq(edges.targetNodeId, removeId), eq(edges.userId, userId)));
  for (const edge of inEdges) {
    await tx
      .insert(edges)
      .values({
        userId: edge.userId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: keepId,
        edgeType: edge.edgeType,
        metadata: edge.metadata,
      })
      .onConflictDoNothing({
        target: [edges.sourceNodeId, edges.targetNodeId, edges.edgeType],
      });
  }
  await tx
    .delete(edges)
    .where(and(eq(edges.targetNodeId, removeId), eq(edges.userId, userId)));
}

/**
 * Rewire source_links entries from removeId to keepId
 */
export async function rewireSourceLinks(
  tx: DrizzleDB,
  removeId: TypeId<"node">,
  keepId: TypeId<"node">,
) {
  const links = await tx
    .select()
    .from(sourceLinks)
    .where(eq(sourceLinks.nodeId, removeId));
  for (const link of links) {
    await tx
      .insert(sourceLinks)
      .values({ ...link, id: undefined, nodeId: keepId })
      .onConflictDoNothing({
        target: [sourceLinks.sourceId, sourceLinks.nodeId],
      });
  }
  await tx.delete(sourceLinks).where(eq(sourceLinks.nodeId, removeId));
}

/**
 * Delete a node for a given user; cascades remove related data
 */
export async function deleteNode(
  tx: DrizzleDB,
  nodeId: TypeId<"node">,
  userId: string,
) {
  await tx
    .delete(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)));
}

/**
 * Step 6: logging summary
 */
function logCleanupSummary(
  params: CleanupGraphParams,
  result: CleanupGraphResult,
): void {
  console.info(
    `[CLEANUP] user=${params.userId} seeds=${params.entryNodeLimit} hops=${params.graphHopDepth} ` +
      `merged=${result.merged.length} removed=${result.removed.length} ` +
      `addedEdges=${result.addedEdges.length} createdNodes=${result.createdNodes.length}`,
  );
}

// Logs a human-readable overview of the LLM cleanup proposal using the mapper
export function logProposalOverview(
  proposal: CleanupProposal,
  mapper: TemporaryIdMapper<GraphNode, string>,
): void {
  console.log("=== Graph Cleanup Proposal Overview ===");

  if (proposal.merges.length) {
    console.log("Merges:");
    proposal.merges.forEach(({ keep, remove }) => {
      const keepNode = mapper.getItem(keep as TypeId<"node">);
      const removeNode = mapper.getItem(remove as TypeId<"node">);
      console.log(
        ` - Merge: ${keep} (${keepNode?.label || ""} / ${keepNode?.description || ""}) <- ${remove} (${removeNode?.label || ""} / ${removeNode?.description || ""})`,
      );
    });
  }

  if (proposal.deletes.length) {
    console.log("Deletes:");
    proposal.deletes.forEach(({ tempId }) => {
      const node = mapper.getItem(tempId as TypeId<"node">);
      console.log(
        ` - Delete: ${tempId} (${node?.label || ""} / ${node?.description || ""})`,
      );
    });
  }

  if (proposal.additions.length) {
    console.log("Additions:");
    proposal.additions.forEach(({ source, target, type, description }) => {
      const sNode = mapper.getItem(source as TypeId<"node">);
      const tNode = mapper.getItem(target as TypeId<"node">);
      console.log(
        ` - Add Edge: ${sNode?.label || ""} -> ${tNode?.label || ""} (${type}) - ${description}`,
      );
    });
  }

  if (proposal.newNodes.length) {
    console.log("New Nodes:");
    proposal.newNodes.forEach(({ tempId, label, description, type }) => {
      console.log(
        ` - New Node: ${tempId}: ${label} (${type}) - ${description || ""}`,
      );
    });
  }
}

/**
 * Truncates all node labels longer than 255 characters for a specific user.
 * This is a simple cleanup operation to prevent excessively long labels from causing issues.
 */
export async function truncateLongLabels(
  userId: string,
): Promise<{ updatedCount: number }> {
  const db = await useDatabase();

  // Find all nodeMetadata records with labels longer than 255 characters for this user
  const longLabelNodes = await db
    .select({
      id: nodeMetadata.id,
      nodeId: nodeMetadata.nodeId,
      label: nodeMetadata.label,
    })
    .from(nodeMetadata)
    .innerJoin(nodes, eq(nodes.id, nodeMetadata.nodeId))
    .where(
      and(
        eq(nodes.userId, userId),
        sql`${nodeMetadata.label} IS NOT NULL`,
        sql`length(${nodeMetadata.label}) > 255`,
      ),
    );

  if (longLabelNodes.length === 0) {
    return { updatedCount: 0 };
  }

  console.log(
    `Found ${longLabelNodes.length} nodes with labels longer than 255 characters`,
  );

  // Update each node's label to be truncated to 255 characters
  let updatedCount = 0;
  for (const node of longLabelNodes) {
    if (node.label) {
      const truncatedLabel = node.label.substring(0, 255);
      await db
        .update(nodeMetadata)
        .set({ label: truncatedLabel })
        .where(eq(nodeMetadata.id, node.id));
      updatedCount++;

      console.log(
        `Truncated label for node ${node.nodeId}: "${node.label.substring(0, 50)}..." -> "${truncatedLabel.substring(0, 50)}..."`,
      );
    }
  }

  console.log(`Successfully truncated ${updatedCount} node labels`);
  return { updatedCount };
}

/**
 * Generates embeddings for nodes that have labels but are missing embeddings.
 * This is a cleanup operation to ensure all nodes with content have searchable embeddings.
 */
export async function generateMissingNodeEmbeddings(
  userId: string,
): Promise<{ generatedCount: number }> {
  const db = await useDatabase();

  // Find nodes that have labels but no embeddings for this user
  const nodesWithoutEmbeddings = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(nodeEmbeddings, eq(nodeEmbeddings.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        sql`${nodeMetadata.label} IS NOT NULL`,
        sql`trim(${nodeMetadata.label}) != ''`,
        sql`${nodeEmbeddings.nodeId} IS NULL`,
      ),
    );

  if (nodesWithoutEmbeddings.length === 0) {
    console.log("No nodes found with labels but missing embeddings");
    return { generatedCount: 0 };
  }

  console.log(
    `Found ${nodesWithoutEmbeddings.length} nodes with labels but missing embeddings`,
  );

  // Use the existing central embedding generation function
  await generateAndInsertNodeEmbeddings(
    db,
    nodesWithoutEmbeddings.map((node) => ({
      id: node.id,
      label: node.label!,
      description: node.description,
    })),
  );

  console.log(
    `Successfully generated embeddings for ${nodesWithoutEmbeddings.length} nodes`,
  );
  return { generatedCount: nodesWithoutEmbeddings.length };
}
