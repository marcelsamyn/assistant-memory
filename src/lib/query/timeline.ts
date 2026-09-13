import {
  assertPartitionReadAllowed,
  partitionAccessCondition,
} from "../partition-access";
import {
  QueryTimelineRequest,
  QueryTimelineResponse,
} from "../schemas/query-timeline";
import { loadTimelinePeriods } from "./timeline-periods";
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import type { MemoryAccessScope } from "~/lib/schemas/partition";
import { NodeTypeEnum } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/**
 * Query a timeline of memories grouped by date.
 *
 * Finds Temporal (day) nodes between the optional inclusive `since`/`until`
 * bounds for a user — each bound is open when omitted, so there is no implied
 * default window — then fetches connected nodes for each day. Supports
 * pagination via limit/offset on days (newest-first), and optional nodeType
 * filtering on the connected nodes. With `includePeriods`, returns the
 * week/month/year rollups covering the in-range days.
 */
export async function queryTimeline(
  params: QueryTimelineRequest & {
    accessScope?: MemoryAccessScope | undefined;
  },
): Promise<QueryTimelineResponse> {
  const {
    userId,
    partitionKey,
    since,
    until,
    limit = 30,
    offset = 0,
    nodeTypes,
    includePeriods,
    accessScope,
  } = params;

  const db = await useDatabase();
  await assertPartitionReadAllowed(db, userId, partitionKey, accessScope);

  const periods = includePeriods
    ? await loadTimelinePeriods(
        db,
        userId,
        since,
        until,
        partitionKey,
        accessScope,
      )
    : [];

  // Shared WHERE clause for day-node lookups. `since`/`until` are inclusive
  // bounds; an omitted bound is open on that side.
  const dayNodeWhere = and(
    eq(nodes.userId, userId),
    partitionAccessCondition(
      nodes.partitionKey,
      userId,
      partitionKey,
      accessScope,
    ),
    eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
    sql`${nodeMetadata.label} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ...(since ? [gte(nodeMetadata.label, since)] : []),
    ...(until ? [lte(nodeMetadata.label, until)] : []),
  );
  const workspaceAggregation =
    accessScope === "workspace" && partitionKey === undefined;

  // Step 1: Count total days with data in the range (DB-level).
  const [countResult] = await db
    .select({
      total: workspaceAggregation ? countDistinct(nodeMetadata.label) : count(),
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(dayNodeWhere);

  const totalDays = countResult?.total ?? 0;

  if (totalDays === 0 || offset >= totalDays) {
    return {
      days: [],
      totalDays,
      hasMore: false,
      periods,
    };
  }

  // Step 2: Fetch the paginated day labels (DB-level limit/offset).
  // Workspace pagination is by distinct date, not by duplicate Temporal rows
  // left behind in separate active partitions. Strict callers retain the
  // historical row pagination behavior.
  const paginatedDayLabels = workspaceAggregation
    ? await db
        .select({ label: nodeMetadata.label })
        .from(nodes)
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(dayNodeWhere)
        .groupBy(nodeMetadata.label)
        .orderBy(desc(nodeMetadata.label))
        .limit(limit)
        .offset(offset)
    : [];
  const selectedDayLabels = paginatedDayLabels.flatMap(({ label }) =>
    label ? [label] : [],
  );
  const paginatedDayNodes = workspaceAggregation
    ? await db
        .select({
          id: nodes.id,
          label: nodeMetadata.label,
        })
        .from(nodes)
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(dayNodeWhere, inArray(nodeMetadata.label, selectedDayLabels)),
        )
        .orderBy(nodeMetadata.label, nodes.id)
    : await db
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
      periods,
    };
  }

  const dayNodeIds = paginatedDayNodes.map((d) => d.id);
  const dayNodeLabelById = new Map(
    paginatedDayNodes.map((dayNode) => [dayNode.id, dayNode.label]),
  );

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
        partitionAccessCondition(
          claims.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
        eq(claims.status, "active"),
        eq(nodes.userId, userId),
        partitionAccessCondition(
          nodes.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
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
  const nodesByDay = new Map<string, typeof connectedRows>();
  for (const row of connectedRows) {
    const dayId = workspaceAggregation
      ? (dayNodeLabelById.get(row.dayNodeId) ?? row.dayNodeId)
      : row.dayNodeId;
    const existing = nodesByDay.get(dayId);
    if (existing) {
      existing.push(row);
    } else {
      nodesByDay.set(dayId, [row]);
    }
  }

  const representativeByDate = new Map<
    string,
    (typeof paginatedDayNodes)[number]
  >();
  if (workspaceAggregation) {
    for (const dayNode of paginatedDayNodes) {
      if (dayNode.label && !representativeByDate.has(dayNode.label)) {
        representativeByDate.set(dayNode.label, dayNode);
      }
    }
  }
  const dayRows = workspaceAggregation
    ? selectedDayLabels.flatMap((label) => {
        const representative = representativeByDate.get(label);
        return representative ? [representative] : [];
      })
    : paginatedDayNodes;

  const days = dayRows.map((dayNode) => {
    const dayId = dayNode.id;
    const dayKey = workspaceAggregation ? dayNode.label! : dayId;
    const allConnected = nodesByDay.get(dayKey) ?? [];

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
    periods,
  };
}
