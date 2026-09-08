/**
 * Atlas section assembler.
 *
 * Reads the user's existing Atlas node `nodeMetadata.description` (which
 * already contains the pinned-then-derived concat produced by
 * `processAtlasJob`). Empty description → no section.
 *
 * The atlas refresh job owns synthesis and budgeting; this assembler is a
 * pure read of the materialised artifact.
 */
import type { ContextSectionAtlas } from "../types";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import { NodeTypeEnum } from "~/types/graph";

const USAGE =
  "Durable user portrait synthesised from trusted personal claims. Use as background; do not re-prompt facts already stated here.";

export async function assembleAtlasSection(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
): Promise<ContextSectionAtlas | null> {
  const [row] = await db
    .select({ description: nodeMetadata.description })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionKey === undefined
          ? isNull(nodes.partitionKey)
          : eq(nodes.partitionKey, partitionKey),
        eq(nodes.nodeType, NodeTypeEnum.enum.Atlas),
        eq(nodeMetadata.label, "Atlas"),
      ),
    )
    .limit(1);

  const content = row?.description?.trim() ?? "";
  if (content.length === 0) return null;

  return {
    kind: "atlas",
    content,
    usage: USAGE,
  };
}
