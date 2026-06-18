import { readRollupMeta } from "../rollup/collect";
import {
  monthKeyForDay,
  periodLevelOf,
  weekKeyForDay,
  yearKeyForMonth,
} from "../rollup/period";
import type { QueryTimelinePeriod } from "../schemas/query-timeline";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";

/**
 * Load week/month/year temporal-rollup summaries for the days in `[since, until]`.
 *
 * Periods are derived from the day nodes that actually fall in range: each in-range
 * day's week/month/year keys are collected, then the matching `Temporal` rollup
 * nodes are loaded. A period therefore appears only when the window contains a day
 * it covers — exactly what the timeline can render — and open bounds (`since` or
 * `until` omitted) work without enumerating a calendar interval.
 *
 * `summary` is null until the rollup job has written a real summary (detected via
 * `additionalData.rollup`), so boilerplate descriptions never surface.
 *
 * aka: timeline rollup periods, week/month/year summaries for a date window.
 */
export async function loadTimelinePeriods(
  db: DrizzleDB,
  userId: string,
  since?: string,
  until?: string,
): Promise<QueryTimelinePeriod[]> {
  // 1. Distinct day-node labels in range (day nodes are `YYYY-MM-DD`).
  const dayRows = await db
    .selectDistinct({ label: nodeMetadata.label })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        sql`${nodeMetadata.label} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
        ...(since ? [gte(nodeMetadata.label, since)] : []),
        ...(until ? [lte(nodeMetadata.label, until)] : []),
      ),
    );

  // 2. The week/month/year keys those days belong to.
  const keys = new Set<string>();
  for (const { label } of dayRows) {
    if (!label) continue;
    const monthKey = monthKeyForDay(label);
    keys.add(weekKeyForDay(label));
    keys.add(monthKey);
    keys.add(yearKeyForMonth(monthKey));
  }
  if (keys.size === 0) return [];

  // 3. The rollup nodes for those keys (day labels are never among them).
  const rows = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        inArray(nodeMetadata.label, [...keys]),
      ),
    )
    .orderBy(nodeMetadata.label);

  return rows.flatMap((row) => {
    const key = row.label!; // inArray on label excludes nulls
    const granularity = periodLevelOf(key);
    if (granularity === "day") return []; // keys never include days; narrows the type
    return [
      {
        key,
        granularity,
        summary: readRollupMeta(row.additionalData) ? row.description : null,
        temporalNodeId: row.id,
      },
    ];
  });
}
