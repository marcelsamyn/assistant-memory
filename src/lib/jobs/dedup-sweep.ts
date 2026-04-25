/** Deterministic dedup sweep: finds exact-label duplicate nodes and merges them. */
import {
  rewireNodeClaims,
  rewireSourceLinks,
  deleteNode,
} from "./cleanup-graph";
import { and, eq, sql, isNotNull } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { nodes, nodeMetadata } from "~/db/schema";
import { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

interface DuplicateGroup {
  nodeType: string;
  canonicalLabel: string;
  nodeIds: TypeId<"node">[];
}

/**
 * Find all groups of nodes that share the same (userId, nodeType, canonicalLabel).
 * Returns groups with 2+ members — these are duplicates.
 */
export async function findDuplicateGroups(
  db: DrizzleDB,
  userId: string,
): Promise<DuplicateGroup[]> {
  const rows = await db
    .select({
      nodeType: nodes.nodeType,
      canonicalLabel: nodeMetadata.canonicalLabel,
      nodeIds: sql<
        TypeId<"node">[]
      >`array_agg(${nodes.id} ORDER BY ${nodes.createdAt} ASC)`.as("node_ids"),
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        isNotNull(nodeMetadata.canonicalLabel),
        sql`trim(${nodeMetadata.canonicalLabel}) != ''`,
      ),
    )
    .groupBy(nodes.nodeType, nodeMetadata.canonicalLabel)
    .having(sql`count(*) > 1`);

  return rows.map((r) => ({
    nodeType: r.nodeType,
    canonicalLabel: r.canonicalLabel!,
    nodeIds: r.nodeIds,
  }));
}

/**
 * Merge a group of duplicate nodes: keep the oldest (first), rewire and delete the rest.
 */
async function mergeGroup(
  tx: DrizzleDB,
  userId: string,
  group: DuplicateGroup,
): Promise<number> {
  const [keepId, ...removeIds] = group.nodeIds;
  if (!keepId || removeIds.length === 0) return 0;

  for (const removeId of removeIds) {
    await rewireNodeClaims(tx, removeId, keepId, userId);
    await rewireSourceLinks(tx, removeId, keepId);
    await deleteNode(tx, removeId, userId);
  }

  return removeIds.length;
}

export interface DedupSweepResult {
  mergedGroups: number;
  mergedNodes: number;
}

/**
 * Run a full dedup sweep for a user: find all exact-label duplicates and merge them.
 */
export async function runDedupSweep(userId: string): Promise<DedupSweepResult> {
  const db = await useDatabase();
  const groups = await findDuplicateGroups(db, userId);

  if (groups.length === 0) {
    console.log(`[dedup-sweep] No duplicates found for user ${userId}`);
    return { mergedGroups: 0, mergedNodes: 0 };
  }

  console.log(
    `[dedup-sweep] Found ${groups.length} duplicate groups for user ${userId}`,
  );

  let totalMerged = 0;

  await db.transaction(async (tx) => {
    for (const group of groups) {
      const merged = await mergeGroup(tx, userId, group);
      totalMerged += merged;
      console.log(
        `[dedup-sweep] Merged ${merged} duplicates of "${group.canonicalLabel}" (${group.nodeType})`,
      );
    }
  });

  console.log(
    `[dedup-sweep] Completed: ${groups.length} groups, ${totalMerged} nodes merged for user ${userId}`,
  );

  return { mergedGroups: groups.length, mergedNodes: totalMerged };
}
