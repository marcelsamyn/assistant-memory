import { generateEmbeddings } from "./embeddings";
import { periodLevelOf, type PeriodLevel } from "./rollup/period";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "~/db/schema";
import { nodeEmbeddings, nodeMetadata, nodes } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

type Database = NodePgDatabase<typeof schema>;

const PERIOD_DESCRIPTION: Record<PeriodLevel, (key: string) => string> = {
  day: (key) => `Represents the day ${key}`,
  week: (key) => `Represents the week ${key}`,
  month: (key) => `Represents the month ${key}`,
  year: (key) => `Represents the year ${key}`,
};

/**
 * Ensures a Temporal node representing the given date exists for the user,
 * creating one if necessary.
 *
 * @returns The TypeId of the existing or newly created day node.
 */
export async function ensureDayNode(
  db: Database,
  userId: string,
  targetDate: Date = new Date(),
): Promise<TypeId<"node">> {
  return ensurePeriodNode(db, userId, format(targetDate, "yyyy-MM-dd"));
}

/**
 * Ensures a Temporal node for any rollup period key (day `yyyy-MM-dd`,
 * week `yyyy-Www`, month `yyyy-MM`, year `yyyy`) exists for the user.
 * Lookup is by `nodeMetadata.label` — the period key IS the label.
 *
 * @throws Error on a malformed key, embedding failure, or insert failure.
 */
export async function ensurePeriodNode(
  db: Database,
  userId: string,
  periodKey: string,
): Promise<TypeId<"node">> {
  const level = periodLevelOf(periodKey);

  const [existingNode] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        eq(nodeMetadata.label, periodKey),
      ),
    )
    .limit(1);

  if (existingNode) {
    return existingNode.id;
  }

  const nodeDescription = PERIOD_DESCRIPTION[level](periodKey);
  const skipEmbedding = shouldSkipEmbeddingPersistence();

  const nodeEmbedding = skipEmbedding
    ? null
    : await generatePeriodNodeEmbedding(periodKey, nodeDescription);

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
        `Failed to retrieve ID after inserting period node: ${periodKey}`,
      );
    }

    const actualNodeId = insertedNode.id;

    await db.transaction(async (tx) => {
      await tx.insert(nodeMetadata).values({
        nodeId: actualNodeId,
        label: periodKey,
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
    console.error(`Failed to create period node ${periodKey}:`, error);
    throw new Error(`Database operation failed for period node ${periodKey}`);
  }
}

async function generatePeriodNodeEmbedding(
  periodKey: string,
  nodeDescription: string,
): Promise<number[]> {
  const embeddingContent = `${periodKey}: ${nodeDescription}`;
  const embeddingsResult = await generateEmbeddings({
    input: [embeddingContent],
    model: "jina-embeddings-v3",
    truncate: true,
  });

  const embedding = embeddingsResult?.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error(
      `Failed to generate valid embedding for period node: ${periodKey}`,
    );
  }
  return embedding;
}
