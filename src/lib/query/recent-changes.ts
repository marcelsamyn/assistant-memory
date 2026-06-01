import {
  aliasedTable,
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { claims, nodeMetadata, nodes, sources } from "~/db/schema";
import {
  type ChangeKind,
  type QueryRecentChangesRequest,
  type QueryRecentChangesResponse,
  type RecentChangeClaim,
  type RecentChangeNode,
  type RecentChangeSource,
} from "~/lib/schemas/query-recent-changes";
import { type NodeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/**
 * Node types that are pure graph infrastructure rather than user-facing
 * "memory content". Excluded from the `nodes` feed by default so a digest
 * isn't flooded with a fresh `Temporal` day node every morning (and the
 * `Atlas` summary / internal `AssistantDream` artifacts). Callers can still
 * surface them by passing them explicitly via `nodeTypes`.
 */
const STRUCTURAL_NODE_TYPES: readonly NodeType[] = [
  "Temporal",
  "Atlas",
  "AssistantDream",
];

/**
 * Minimal view of `sources.metadata` for title rendering. Kept local so this
 * read path doesn't pull the MinIO-backed `~/lib/sources` module into the
 * query layer.
 */
const sourceTitleMetadataSchema = z
  .object({
    // Allow any string here and enforce non-empty in `deriveSourceTitle`: an
    // empty `title` must not fail the whole parse and skip the `filename`
    // fallback.
    title: z.string().optional(),
    filename: z.string().optional(),
  })
  .catchall(z.unknown());

function deriveSourceTitle(metadata: unknown): string | null {
  const parsed = sourceTitleMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) return null;
  const title = parsed.data.title?.trim();
  if (title) return title;
  const filename = parsed.data.filename?.trim();
  if (filename) return filename;
  return null;
}

function toTime(value: Date | string): number {
  return new Date(value).getTime();
}

/**
 * "What's new in memory" feed over a time range. Returns active personal
 * claims and the nodes added/updated within `[since, until]`, with labels and
 * provenance so consumers render without an N+1 fan-out. See the schema module
 * for the full contract.
 */
export async function queryRecentChanges(
  params: QueryRecentChangesRequest,
): Promise<QueryRecentChangesResponse> {
  const { userId, nodeTypes, limit } = params;
  const since = new Date(params.since);
  const until = params.until ? new Date(params.until) : new Date();

  // Empty range (e.g. a caller passing since > until) → nothing to report.
  if (since > until) {
    return { claims: [], nodes: [], sources: [] };
  }

  const db = await useDatabase();

  // A claim counts as changed when either its insert (createdAt) or its last
  // mutation (updatedAt) lands inside the window. GREATEST orders by whichever
  // happened most recently.
  const claimChangedInWindow = or(
    and(gte(claims.createdAt, since), lte(claims.createdAt, until)),
    and(gte(claims.updatedAt, since), lte(claims.updatedAt, until)),
  );
  const claimChangedAt = sql<Date>`GREATEST(${claims.createdAt}, ${claims.updatedAt})`;

  // Node-type filter shared by the node queries: an explicit allow-list when
  // `nodeTypes` is given, otherwise drop the structural infrastructure types.
  // The truthiness check narrows `nodeTypes` to a defined array for `inArray`.
  const nodeTypeFilter =
    nodeTypes && nodeTypes.length > 0
      ? inArray(nodes.nodeType, nodeTypes)
      : notInArray(nodes.nodeType, [...STRUCTURAL_NODE_TYPES]);

  // --- Claims changed in the window ---------------------------------------
  // The subject node joins as the base `nodes` table; the object node's label
  // comes from an aliased `node_metadata`. The object node itself is only
  // needed for the `nodeTypes` filter, so it's reached via a correlated
  // EXISTS rather than a second join on `nodes` — a `nodes` self-join defeats
  // Drizzle's result-type inference and collapses the row type to `never`.
  const objectMeta = aliasedTable(nodeMetadata, "object_meta");
  const objectNode = aliasedTable(nodes, "object_node");

  // Claims are kept when their subject or object node matches `nodeTypes`.
  const claimTypeFilter =
    nodeTypes && nodeTypes.length > 0
      ? or(
          inArray(nodes.nodeType, nodeTypes),
          exists(
            db
              .select({ one: sql`1` })
              .from(objectNode)
              .where(
                and(
                  eq(objectNode.id, claims.objectNodeId),
                  inArray(objectNode.nodeType, nodeTypes),
                ),
              ),
          ),
        )
      : undefined;

  const claimRows = await db
    .select({
      id: claims.id,
      predicate: claims.predicate,
      statement: claims.statement,
      subjectLabel: nodeMetadata.label,
      // Relationship claims carry an object node (and thus a label); attribute
      // claims carry a literal `objectValue`. Coalesced into `objectLabel` below.
      objectNodeLabel: objectMeta.label,
      objectValue: claims.objectValue,
      sourceId: claims.sourceId,
      statedAt: claims.statedAt,
      createdAt: claims.createdAt,
      assertedByKind: claims.assertedByKind,
      // Carried so updated-node candidates can be resolved in-memory below.
      subjectNodeId: claims.subjectNodeId,
      objectNodeId: claims.objectNodeId,
      changedAt: claimChangedAt.as("changed_at"),
    })
    .from(claims)
    .innerJoin(nodes, eq(nodes.id, claims.subjectNodeId))
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, claims.subjectNodeId))
    .leftJoin(objectMeta, eq(objectMeta.nodeId, claims.objectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        eq(claims.scope, "personal"),
        claimChangedInWindow,
        claimTypeFilter,
      ),
    )
    .orderBy(desc(claimChangedAt))
    .limit(limit);

  const claimsOut: RecentChangeClaim[] = claimRows.map((row) => ({
    id: row.id,
    predicate: row.predicate,
    statement: row.statement,
    subjectLabel: row.subjectLabel,
    objectLabel: row.objectNodeLabel ?? row.objectValue,
    sourceId: row.sourceId,
    statedAt: row.statedAt,
    changeKind: row.createdAt >= since ? "added" : "updated",
    assertedByKind: row.assertedByKind,
  }));

  // --- Nodes added in the window ------------------------------------------
  const addedNodeRows = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      firstSeenAt: nodes.createdAt,
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        gte(nodes.createdAt, since),
        lte(nodes.createdAt, until),
        nodeTypeFilter,
      ),
    )
    .orderBy(desc(nodes.createdAt))
    .limit(limit);

  // --- Existing nodes touched by a claim in the window (updated) ----------
  // The claims above are capped at `limit`, so the set of nodes they touch is
  // small. Resolve candidate node ids and their most recent change time
  // in-memory, then look them up by primary key — this avoids a
  // `subjectNodeId = id OR objectNodeId = id` join, which can't use either
  // claim index efficiently in Postgres.
  const nodeChanges = new Map<TypeId<"node">, Date>();
  for (const row of claimRows) {
    const changedAt = new Date(row.changedAt);
    for (const nodeId of [row.subjectNodeId, row.objectNodeId]) {
      if (!nodeId) continue;
      const current = nodeChanges.get(nodeId);
      if (!current || changedAt > current) nodeChanges.set(nodeId, changedAt);
    }
  }
  const candidateNodeIds = Array.from(nodeChanges.keys());

  // Candidates created before the window are "updated"; those created inside it
  // already surface as "added" above and are excluded here via `createdAt < since`.
  const updatedNodeRows =
    candidateNodeIds.length > 0
      ? await db
          .select({
            id: nodes.id,
            nodeType: nodes.nodeType,
            label: nodeMetadata.label,
            firstSeenAt: nodes.createdAt,
          })
          .from(nodes)
          .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
          .where(
            and(
              eq(nodes.userId, userId),
              inArray(nodes.id, candidateNodeIds),
              lt(nodes.createdAt, since),
              nodeTypeFilter,
            ),
          )
      : [];

  // Merge added + updated nodes, newest change first, capped at `limit`.
  // "Change time" is the createdAt for added nodes and the most recent
  // touching-claim change for updated ones.
  type SortableNode = RecentChangeNode & { changedAt: Date | string };
  const mergedNodes: SortableNode[] = [
    ...addedNodeRows.map((row) => ({
      id: row.id,
      nodeType: row.nodeType,
      label: row.label,
      changeKind: "added" as ChangeKind,
      firstSeenAt: row.firstSeenAt,
      changedAt: row.firstSeenAt,
    })),
    ...updatedNodeRows.map((row) => ({
      id: row.id,
      nodeType: row.nodeType,
      label: row.label,
      changeKind: "updated" as ChangeKind,
      firstSeenAt: row.firstSeenAt,
      changedAt: nodeChanges.get(row.id) ?? row.firstSeenAt,
    })),
  ];

  const nodesOut: RecentChangeNode[] = mergedNodes
    .sort((a, b) => toTime(b.changedAt) - toTime(a.changedAt))
    .slice(0, limit)
    .map((node) => ({
      id: node.id,
      nodeType: node.nodeType,
      label: node.label,
      changeKind: node.changeKind,
      firstSeenAt: node.firstSeenAt,
    }));

  // --- Sources behind the returned claims ---------------------------------
  const sourceIds = Array.from(new Set(claimsOut.map((c) => c.sourceId)));
  let sourcesOut: RecentChangeSource[] = [];
  if (sourceIds.length > 0) {
    const sourceRows = await db
      .select({
        id: sources.id,
        type: sources.type,
        metadata: sources.metadata,
        lastIngestedAt: sources.lastIngestedAt,
        createdAt: sources.createdAt,
      })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          inArray(sources.id, sourceIds as TypeId<"source">[]),
        ),
      );

    sourcesOut = sourceRows
      .map((row) => ({
        sourceId: row.id,
        type: row.type,
        title: deriveSourceTitle(row.metadata),
        timestamp: row.lastIngestedAt ?? row.createdAt,
      }))
      .sort((a, b) => toTime(b.timestamp) - toTime(a.timestamp));
  }

  return { claims: claimsOut, nodes: nodesOut, sources: sourcesOut };
}
