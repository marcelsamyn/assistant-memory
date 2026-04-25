import {
  QueryTimelineRequest,
  QueryTimelineResponse,
} from "../schemas/query-timeline";
import { format, subDays } from "date-fns";
import { and, eq, or, gte, lte, desc, inArray, sql, count } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/**
 * Query a timeline of memories grouped by date.
 *
 * Finds all Temporal (day) nodes within a date range for a user,
 * then fetches connected nodes for each day. Supports pagination
 * via limit/offset on days, and optional nodeType filtering on
 * the connected nodes.
 */
export async function queryTimeline(
  params: QueryTimelineRequest,
): Promise<QueryTimelineResponse> {
  const { userId, limit = 30, offset = 0, nodeTypes } = params;

  const today = format(new Date(), "yyyy-MM-dd");
  const ninetyDaysAgo = format(subDays(new Date(), 90), "yyyy-MM-dd");
  const startDate = params.startDate ?? today;
  const endDate = params.endDate ?? ninetyDaysAgo;

  // Normalize so rangeMin <= rangeMax regardless of param ordering
  const rangeMin = startDate < endDate ? startDate : endDate;
  const rangeMax = startDate < endDate ? endDate : startDate;

  const db = await useDatabase();

  // Shared WHERE clause for day-node lookups
  const dayNodeWhere = and(
    eq(nodes.userId, userId),
    eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
    gte(nodeMetadata.label, rangeMin),
    lte(nodeMetadata.label, rangeMax),
  );

  // Step 1: Count total days with data in the range (DB-level).
  const [countResult] = await db
    .select({ total: count() })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(dayNodeWhere);

  const totalDays = countResult?.total ?? 0;

  if (totalDays === 0 || offset >= totalDays) {
    return {
      days: [],
      totalDays,
      hasMore: false,
    };
  }

  // Step 2: Fetch the paginated day nodes (DB-level limit/offset).
  // Most recent first so pagination scrolls backward in time.
  const paginatedDayNodes = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(dayNodeWhere)
    .orderBy(desc(nodeMetadata.label))
    .limit(limit)
    .offset(offset);

  if (paginatedDayNodes.length === 0) {
    return {
      days: [],
      totalDays,
      hasMore: false,
    };
  }

  const dayNodeIds = paginatedDayNodes.map((d) => d.id);

  // Step 3: Batch-fetch all connected nodes for the paginated day nodes.
  // This avoids N+1 queries — one query gets everything.
  const connectedRows = await db
    .select({
      dayNodeId: sql<TypeId<"node">>`
        CASE
          WHEN ${inArray(claims.subjectNodeId, dayNodeIds)}
            THEN ${claims.subjectNodeId}
          ELSE ${claims.objectNodeId}
        END
      `.as("day_node_id"),
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      predicate: claims.predicate,
      createdAt: nodes.createdAt,
    })
    .from(claims)
    .innerJoin(
      nodes,
      eq(
        nodes.id,
        sql`CASE
          WHEN ${inArray(claims.subjectNodeId, dayNodeIds)}
            THEN ${claims.objectNodeId}
          ELSE ${claims.subjectNodeId}
        END`,
      ),
    )
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        eq(nodes.userId, userId),
        or(
          inArray(claims.subjectNodeId, dayNodeIds),
          inArray(claims.objectNodeId, dayNodeIds),
        ),
        // Exclude the day nodes themselves from results
        sql`CASE
          WHEN ${inArray(claims.subjectNodeId, dayNodeIds)}
            THEN ${claims.objectNodeId}
          ELSE ${claims.subjectNodeId}
        END NOT IN (${sql.join(
          dayNodeIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );

  // Step 4: Group connected nodes by day node and build response.
  const nodesByDay = new Map<TypeId<"node">, typeof connectedRows>();
  for (const row of connectedRows) {
    const dayId = row.dayNodeId;
    const existing = nodesByDay.get(dayId);
    if (existing) {
      existing.push(row);
    } else {
      nodesByDay.set(dayId, [row]);
    }
  }

  const days = paginatedDayNodes.map((dayNode) => {
    const dayId = dayNode.id;
    const allConnected = nodesByDay.get(dayId) ?? [];

    // Deduplicate by node id (a node can be connected via multiple edges)
    const uniqueMap = new Map<string, (typeof allConnected)[number]>();
    for (const row of allConnected) {
      if (!uniqueMap.has(row.id)) {
        uniqueMap.set(row.id, row);
      }
    }
    const totalNodeCount = uniqueMap.size;

    // Apply nodeTypes filter if requested (after counting total)
    let filteredNodes = allConnected;
    if (nodeTypes && nodeTypes.length > 0) {
      filteredNodes = allConnected.filter((r) =>
        nodeTypes.includes(r.nodeType as (typeof nodeTypes)[number]),
      );
    }

    // Deduplicate the filtered set
    const filteredUniqueMap = new Map<string, (typeof filteredNodes)[number]>();
    for (const row of filteredNodes) {
      if (!filteredUniqueMap.has(row.id)) {
        filteredUniqueMap.set(row.id, row);
      }
    }

    return {
      date: dayNode.label!,
      temporalNodeId: dayId,
      nodeCount: totalNodeCount,
      nodes: Array.from(filteredUniqueMap.values()).map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
        nodeType: r.nodeType,
        predicate: r.predicate,
        createdAt: r.createdAt,
      })),
    };
  });

  return {
    days,
    totalDays,
    hasMore: offset + limit < totalDays,
  };
}
