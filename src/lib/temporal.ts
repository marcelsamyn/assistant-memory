import { generateEmbeddings } from "./embeddings";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "~/db/schema";
import { nodeEmbeddings, nodeMetadata, nodes } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

type Database = NodePgDatabase<typeof schema>;

/**
 * Ensures a Temporal node representing the given date exists for the user,
 * creating one if necessary.
 * Finds the node based on the metadata label (YYYY-MM-DD) for robustness.
 *
 * @param db The Drizzle database instance.
 * @param userId The ID of the user.
 * @param targetDate The date for which to ensure a node exists (defaults to today).
 * @returns The TypeId of the existing or newly created day node.
 * @throws Error if embedding generation fails or database insertion fails.
 */
export async function ensureDayNode(
  db: Database,
  userId: string,
  targetDate: Date = new Date(),
): Promise<TypeId<"node">> {
  const dateLabel = format(targetDate, "yyyy-MM-dd");

  // --- Find existing day node by LABEL, not just timestamp ---
  const [existingDayNode] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        eq(nodeMetadata.label, dateLabel),
      ),
    )
    .limit(1);
  // --- End Label-based check ---

  if (existingDayNode) {
    return existingDayNode.id;
  }

  const nodeDescription = `Represents the day ${dateLabel}`;
  const skipEmbedding = shouldSkipEmbeddingPersistence();

  const nodeEmbedding = skipEmbedding
    ? null
    : await generateDayNodeEmbedding(dateLabel, nodeDescription);

  try {
    const [insertedNode] = await db
      .insert(nodes)
      .values({
        userId,
        nodeType: NodeTypeEnum.enum.Temporal,
      })
      .returning({ id: nodes.id });

    if (!insertedNode) {
      throw new Error(
        `Failed to retrieve ID after inserting day node: ${dateLabel}`,
      );
    }

    const actualNodeId = insertedNode.id;

    await db.transaction(async (tx) => {
      await tx.insert(nodeMetadata).values({
        nodeId: actualNodeId,
        label: dateLabel,
        description: nodeDescription,
      });
      if (nodeEmbedding) {
        await tx.insert(nodeEmbeddings).values({
          nodeId: actualNodeId,
          embedding: nodeEmbedding,
          modelName: "jina-embeddings-v3",
        });
      }
    });

    return actualNodeId;
  } catch (error) {
    console.error(`Failed to create day node ${dateLabel}:`, error);
    throw new Error(`Database operation failed for day node ${dateLabel}`);
  }
}

async function generateDayNodeEmbedding(
  dateLabel: string,
  nodeDescription: string,
): Promise<number[]> {
  const embeddingContent = `${dateLabel}: ${nodeDescription}`;
  const embeddingsResult = await generateEmbeddings({
    input: [embeddingContent],
    model: "jina-embeddings-v3",
    truncate: true,
  });

  const embedding = embeddingsResult?.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error(
      `Failed to generate valid embedding for day node: ${dateLabel}`,
    );
  }
  return embedding;
}
