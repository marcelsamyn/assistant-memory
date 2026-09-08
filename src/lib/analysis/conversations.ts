import { subDays } from "date-fns";
import { and, eq, gte, isNull } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { nodes, nodeMetadata } from "~/db/schema";
import { formatLabelDescList } from "~/lib/formatting";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import { NodeTypeEnum } from "~/types/graph";

/**
 * Fetches and formats conversation summaries for the user of the last 24 hours.
 */
export async function fetchDailyConversationsList(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
): Promise<string> {
  const from = subDays(new Date(), 1);
  const convs = await db
    .select({ title: nodeMetadata.label, summary: nodeMetadata.description })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionKey === undefined
          ? isNull(nodes.partitionKey)
          : eq(nodes.partitionKey, partitionKey),
        eq(nodes.nodeType, NodeTypeEnum.enum.Conversation),
        gte(nodes.createdAt, from),
      ),
    );
  return formatLabelDescList(
    convs.map((n) => ({ label: n.title, description: n.summary })),
  );
}
