/**
 * Deterministic pruning for legacy orphan entity nodes.
 *
 * A prunable orphan is a node with no claims as subject/object/speaker, no
 * source links, and no aliases. These rows are not memory: they have no
 * evidence and cannot be safely re-linked. The job defaults to entity/task
 * node types so generated/system nodes such as AssistantDream and Atlas are
 * not swept accidentally.
 *
 * Common aliases: prune orphan nodes, orphan node cleanup, evidence-free nodes.
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { aliases, claims, nodeMetadata, nodes, sourceLinks } from "~/db/schema";
import {
  pruneOrphanNodesRequestSchema,
  type PruneOrphanNode,
  type PruneOrphanNodesRequest,
  type PruneOrphanNodesResponse,
} from "~/lib/schemas/prune-orphan-nodes";
import type { NodeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

const DEFAULT_PRUNABLE_NODE_TYPES = [
  "Person",
  "Location",
  "Event",
  "Object",
  "Emotion",
  "Concept",
  "Media",
  "Feedback",
  "Idea",
  "Task",
] as const satisfies readonly NodeType[];

interface OrphanCandidateRow {
  id: TypeId<"node">;
  nodeType: NodeType;
  label: string | null;
  createdAt: Date;
}

function orphanEvidenceFreeCondition(userId: string): ReturnType<typeof and> {
  return and(
    sql`NOT EXISTS (
      SELECT 1 FROM ${claims}
      WHERE ${claims.userId} = ${userId}
        AND (
          ${claims.subjectNodeId} = ${nodes.id}
          OR ${claims.objectNodeId} = ${nodes.id}
          OR ${claims.assertedByNodeId} = ${nodes.id}
        )
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${sourceLinks}
      WHERE ${sourceLinks.nodeId} = ${nodes.id}
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM ${aliases}
      WHERE ${aliases.userId} = ${userId}
        AND ${aliases.canonicalNodeId} = ${nodes.id}
    )`,
  );
}

async function findOrphanCandidates(
  db: DrizzleDB,
  params: {
    userId: string;
    cutoff: Date;
    limit: number;
    nodeTypes: readonly NodeType[];
  },
): Promise<OrphanCandidateRow[]> {
  if (params.nodeTypes.length === 0) return [];

  return db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, params.userId),
        lt(nodes.createdAt, params.cutoff),
        inArray(nodes.nodeType, [...params.nodeTypes]),
        orphanEvidenceFreeCondition(params.userId),
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(params.limit);
}

async function deleteStillOrphanNodes(
  db: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<number> {
  if (nodeIds.length === 0) return 0;

  const deleted = await db
    .delete(nodes)
    .where(
      and(
        eq(nodes.userId, userId),
        inArray(nodes.id, nodeIds),
        // Re-check evidence at the destructive boundary in case another
        // ingestion linked a candidate between selection and deletion.
        orphanEvidenceFreeCondition(userId),
      ),
    )
    .returning({ id: nodes.id });

  return deleted.length;
}

/**
 * Prune evidence-free orphan nodes. Dry-run returns the candidate count and a
 * bounded sample; destructive mode deletes up to `limit` still-orphan rows.
 */
export async function pruneOrphanNodes(
  rawInput: PruneOrphanNodesRequest,
  dbOverride?: DrizzleDB,
): Promise<PruneOrphanNodesResponse> {
  const input = pruneOrphanNodesRequestSchema.parse(rawInput);
  const db = dbOverride ?? (await useDatabase());
  const nodeTypes = input.nodeTypes ?? [...DEFAULT_PRUNABLE_NODE_TYPES];
  const cutoff = new Date(
    Date.now() - input.olderThanDays * 24 * 60 * 60 * 1000,
  );

  const candidatesPlusOne = await findOrphanCandidates(db, {
    userId: input.userId,
    cutoff,
    limit: input.limit + 1,
    nodeTypes,
  });
  const hasMore = candidatesPlusOne.length > input.limit;
  const candidates = candidatesPlusOne.slice(0, input.limit);

  const deletedCount = input.dryRun
    ? 0
    : await deleteStillOrphanNodes(
        db,
        input.userId,
        candidates.map((candidate) => candidate.id),
      );

  const sample: PruneOrphanNode[] = candidates
    .slice(0, input.sampleLimit)
    .map((candidate) => ({
      id: candidate.id,
      nodeType: candidate.nodeType,
      label: candidate.label,
      createdAt: candidate.createdAt,
    }));

  return {
    dryRun: input.dryRun,
    candidateCount: candidates.length,
    deletedCount,
    hasMore,
    scannedNodeTypes: nodeTypes,
    candidates: sample,
  };
}
