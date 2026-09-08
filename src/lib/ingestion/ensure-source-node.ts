import { ensureDayNode } from "../temporal";
import { and, eq } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { claims, nodes, sourceLinks, sources, NodeSelect } from "~/db/schema";
import {
  assertPartitionReadAllowed,
  withSourceWriteFence,
} from "~/lib/partition-access";
import { NodeType } from "~/types/graph";
import { TypeId } from "~/types/typeid";

interface EnsureSourceNodeParams {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  /** Version captured before this worker performed non-transactional work. */
  expectedSourceVersion?: number;
  timestamp: Date;
  nodeType: NodeType;
}

/**
 * Ensures a graph node of the specified type exists for a given source,
 * links it to the source, and connects it to a day node.
 * If the node already exists for this source, it's returned.
 * Otherwise, a new node is created and linked.
 * @returns The ID of the (existing or new) graph node.
 */
export async function ensureSourceNode({
  db,
  userId,
  sourceId,
  expectedSourceVersion,
  timestamp,
  nodeType,
}: EnsureSourceNodeParams): Promise<TypeId<"node">> {
  return withSourceWriteFence(
    db,
    {
      userId,
      sources: [
        {
          sourceId,
          ...(expectedSourceVersion !== undefined
            ? { expectedSourceVersion }
            : {}),
        },
      ],
    },
    async (tx) => {
      let graphNode: NodeSelect | undefined;
      const [source] = await tx
        .select({ partitionKey: sources.partitionKey, scope: sources.scope })
        .from(sources)
        .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
        .limit(1);
      if (!source)
        throw new Error(`Source ${sourceId} was not found for user ${userId}`);
      await assertPartitionReadAllowed(
        tx,
        userId,
        source.partitionKey ?? undefined,
      );

      // Check if a node of the given type is already linked to this source
      const existingNodeResult = await tx
        .select({
          node: nodes,
        })
        .from(nodes)
        .innerJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
        .where(
          and(
            eq(nodes.userId, userId),
            eq(nodes.nodeType, nodeType),
            eq(sourceLinks.sourceId, sourceId),
          ),
        )
        .limit(1);

      graphNode = existingNodeResult[0]?.node;
      if (graphNode && graphNode.partitionKey !== source.partitionKey) {
        throw new Error(
          `Source ${sourceId} is linked to a node in a different memory partition`,
        );
      }

      if (!graphNode) {
        // Create the graph node
        const [newNode] = await tx
          .insert(nodes)
          .values({
            userId,
            partitionKey: source.partitionKey,
            nodeType,
            createdAt: timestamp,
          })
          .returning();

        if (!newNode) {
          throw new Error(
            `Failed to create ${nodeType} node for source ${sourceId}`,
          );
        }

        // Link to source
        const [newSourceLink] = await tx
          .insert(sourceLinks)
          .values({
            sourceId,
            nodeId: newNode.id,
          })
          .returning();

        if (!newSourceLink) {
          throw new Error(
            `Failed to create source link for ${nodeType} node ${newNode.id} and source ${sourceId}`,
          );
        }

        // Link to day node with a sourced bookkeeping relationship claim.
        const dayNodeId = await ensureDayNode(
          tx,
          userId,
          timestamp,
          source.partitionKey ?? undefined,
        );
        await tx.insert(claims).values({
          userId,
          predicate: "RECORDED_ON",
          subjectNodeId: newNode.id,
          objectNodeId: dayNodeId,
          statement: `${nodeType} source recorded on ${timestamp.toISOString().slice(0, 10)}`,
          sourceId,
          partitionKey: source.partitionKey,
          scope: source.scope,
          assertedByKind: "system",
          statedAt: timestamp,
          status: "active",
        });

        graphNode = newNode;
      }

      return graphNode.id;
    },
  );
}
