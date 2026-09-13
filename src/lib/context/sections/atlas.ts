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
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import { getWorkspaceAtlasEntries } from "~/lib/atlas";
import { partitionAccessCondition } from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
import { NodeTypeEnum } from "~/types/graph";

const USAGE =
  "Durable user portrait synthesised from trusted personal claims. Use as background; do not re-prompt facts already stated here.";

export async function assembleAtlasSection(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
  accessScope?: MemoryAccessScope | undefined,
): Promise<ContextSectionAtlas | null> {
  if (accessScope === "workspace" && partitionKey === undefined) {
    // The workspace helper applies one bounded, active-partition query and
    // returns partition labels so descriptions from separate rooms stay
    // distinguishable in the combined section.
    const { user } = await getWorkspaceAtlasEntries(db, userId, "");
    const content = user
      .filter((row) => row.description?.trim())
      .map(
        (row) =>
          `<context type="User Atlas" partition="${row.partitionKey ?? "legacy"}">
${row.description!.trim()}
</context>`,
      )
      .join("\n");
    if (content.length === 0) return null;
    return { kind: "atlas", content, usage: USAGE };
  }

  const [row] = await db
    .select({ description: nodeMetadata.description })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionAccessCondition(
          nodes.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
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
