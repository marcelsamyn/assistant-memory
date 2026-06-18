import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import {
  SampleNodesRequest,
  SampleNodesResponse,
} from "~/lib/schemas/sample-nodes";
import { useDatabase } from "~/utils/db";

/** Node types that are scaffolding/system-owned, never "wander into" targets. */
const NOISE_NODE_TYPES = ["Temporal", "Atlas", "AssistantDream"];
const MIN_CONNECTIONS = 3;
const POOL_SIZE = 60;

/**
 * Sample a handful of "interesting" nodes for the Explore empty state:
 * labeled, non-noise nodes with >= 3 active connections. We rank the most
 * connected into a pool of POOL_SIZE, then draw `limit` at random from it —
 * so results feel substantive but vary on each call (the UI's "shuffle").
 */
export async function sampleInterestingNodes(
  params: SampleNodesRequest,
): Promise<SampleNodesResponse> {
  const { userId, limit, nodeTypes } = params;
  const db = await useDatabase();

  // A node's "connections" are the active claims it appears in, as subject or
  // object. We unnest both roles via UNION ALL rather than an `OR` join
  // predicate — an `OR` across two columns prevents Postgres from using the
  // per-column indexes, while each UNION ALL branch is a clean equality join
  // that can.
  const connections = unionAll(
    db
      .select({ nodeId: claims.subjectNodeId, claimId: claims.id })
      .from(claims)
      .where(and(eq(claims.userId, userId), eq(claims.status, "active"))),
    db
      .select({ nodeId: claims.objectNodeId, claimId: claims.id })
      .from(claims)
      .where(
        and(
          eq(claims.userId, userId),
          eq(claims.status, "active"),
          isNotNull(claims.objectNodeId),
        ),
      ),
  ).as("connections");

  // CTE 1: connection counts for qualifying nodes.
  const conn = db.$with("conn").as(
    db
      .select({
        id: nodes.id,
        nodeType: nodes.nodeType,
        label: nodeMetadata.label,
        description: nodeMetadata.description,
        connectionCount: sql<string>`count(${connections.claimId})`.as(
          "connection_count",
        ),
      })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .innerJoin(connections, eq(connections.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          isNotNull(nodeMetadata.label),
          notInArray(nodes.nodeType, NOISE_NODE_TYPES),
          ...(nodeTypes && nodeTypes.length > 0
            ? [inArray(nodes.nodeType, nodeTypes)]
            : []),
        ),
      )
      .groupBy(
        nodes.id,
        nodes.nodeType,
        nodeMetadata.label,
        nodeMetadata.description,
      )
      .having(sql`count(${connections.claimId}) >= ${MIN_CONNECTIONS}`),
  );

  // CTE 2: the top-connected pool.
  const pool = db
    .$with("pool")
    .as(
      db
        .select()
        .from(conn)
        .orderBy(desc(conn.connectionCount))
        .limit(POOL_SIZE),
    );

  // Draw `limit` at random from the pool.
  const rows = await db
    .with(conn, pool)
    .select()
    .from(pool)
    .orderBy(sql`random()`)
    .limit(limit);

  return {
    nodes: rows.map((r) => ({
      id: r.id,
      nodeType: r.nodeType,
      label: r.label ?? "",
      description: r.description,
      connectionCount: Number(r.connectionCount),
    })),
  };
}
