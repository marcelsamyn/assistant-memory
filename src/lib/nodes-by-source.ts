/**
 * Read-side helper for `POST /sources/nodes`. Bulk fetches every node
 * derived from a set of source IDs, plus (optionally) the active claims
 * attached to those nodes. Used by hosts that always-inject the full
 * context of a project's attached source set.
 */
import {
  aliasedTable,
  and,
  desc,
  eq,
  inArray,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, sourceLinks } from "~/db/schema";
import type { GetNodeResponse } from "~/lib/schemas/node";
import {
  DEFAULT_EXCLUDED_NODE_TYPES,
  type NodesBySourceResponse,
  type SourceNode,
} from "~/lib/schemas/nodes-by-source";
import type { NodeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

interface NodesCursor {
  /** ISO `nodes.createdAt`. */
  c: string;
  /** Node id — tiebreaker. */
  i: string;
}

function encodeCursor(cursor: NodesCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): NodesCursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<NodesCursor>;
    if (typeof decoded.c !== "string" || typeof decoded.i !== "string") {
      return null;
    }
    return { c: decoded.c, i: decoded.i };
  } catch {
    return null;
  }
}

interface FetchParams {
  db: DrizzleDB;
  userId: string;
  sourceIds: TypeId<"source">[];
  nodeTypes: NodeType[] | undefined;
  includeClaims: boolean;
  limit: number;
  cursor: string | undefined;
}

export async function fetchNodesBySource(
  params: FetchParams,
): Promise<NodesBySourceResponse> {
  const { db, userId, sourceIds, nodeTypes, includeClaims, limit } = params;
  const decoded = params.cursor ? decodeCursor(params.cursor) : null;

  const whereClauses = [
    eq(nodes.userId, userId),
    inArray(sourceLinks.sourceId, sourceIds),
  ];

  if (nodeTypes && nodeTypes.length > 0) {
    whereClauses.push(inArray(nodes.nodeType, nodeTypes));
  } else {
    whereClauses.push(
      notInArray(nodes.nodeType, [...DEFAULT_EXCLUDED_NODE_TYPES]),
    );
  }

  if (decoded) {
    whereClauses.push(
      or(
        sql`${nodes.createdAt} < ${decoded.c}::timestamptz`,
        and(
          sql`${nodes.createdAt} = ${decoded.c}::timestamptz`,
          lt(nodes.id, decoded.i as TypeId<"node">),
        ),
      )!,
    );
  }

  // First: distinct page of node ids in deterministic order.
  const idRows = await db
    .selectDistinct({
      id: nodes.id,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .innerJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
    .where(and(...whereClauses))
    .orderBy(desc(nodes.createdAt), desc(nodes.id))
    .limit(limit + 1);

  const hasMore = idRows.length > limit;
  const pageIdRows = hasMore ? idRows.slice(0, limit) : idRows;
  const pageIds = pageIdRows.map((r) => r.id);

  if (pageIds.length === 0) {
    return { nodes: [], claims: [], nextCursor: null };
  }

  // Hydrate node detail and which of the input sourceIds each node came from.
  const detailRows = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      createdAt: nodes.createdAt,
      sourceId: sourceLinks.sourceId,
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .innerJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        inArray(nodes.id, pageIds),
        inArray(sourceLinks.sourceId, sourceIds),
      ),
    );

  const nodeById = new Map<string, SourceNode>();
  for (const row of detailRows) {
    const existing = nodeById.get(row.id);
    if (existing) {
      if (!existing.sourceIds.includes(row.sourceId)) {
        existing.sourceIds.push(row.sourceId);
      }
      continue;
    }
    nodeById.set(row.id, {
      id: row.id,
      nodeType: row.nodeType,
      label: row.label ?? null,
      description: row.description ?? null,
      createdAt: row.createdAt,
      sourceIds: [row.sourceId],
    });
  }

  // Preserve the keyset ordering from the id query.
  const orderedNodes: SourceNode[] = pageIds
    .map((id) => nodeById.get(id))
    .filter((n): n is SourceNode => n !== undefined);

  let claimRows: GetNodeResponse["claims"] = [];
  if (includeClaims) {
    const srcMeta = aliasedTable(nodeMetadata, "srcMeta");
    const tgtMeta = aliasedTable(nodeMetadata, "tgtMeta");

    claimRows = await db
      .select({
        id: claims.id,
        subjectNodeId: claims.subjectNodeId,
        objectNodeId: claims.objectNodeId,
        objectValue: claims.objectValue,
        predicate: claims.predicate,
        statement: claims.statement,
        description: claims.description,
        subjectLabel: srcMeta.label,
        objectLabel: tgtMeta.label,
        sourceId: claims.sourceId,
        scope: claims.scope,
        assertedByKind: claims.assertedByKind,
        assertedByNodeId: claims.assertedByNodeId,
        status: claims.status,
        statedAt: claims.statedAt,
      })
      .from(claims)
      .leftJoin(srcMeta, eq(srcMeta.nodeId, claims.subjectNodeId))
      .leftJoin(tgtMeta, eq(tgtMeta.nodeId, claims.objectNodeId))
      .where(
        and(
          eq(claims.userId, userId),
          eq(claims.status, "active"),
          inArray(claims.subjectNodeId, pageIds),
        ),
      );
  }

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = pageIdRows[pageIdRows.length - 1]!;
    nextCursor = encodeCursor({
      c: last.createdAt.toISOString(),
      i: last.id,
    });
  }

  return { nodes: orderedNodes, claims: claimRows, nextCursor };
}
