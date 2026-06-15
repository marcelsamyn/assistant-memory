import { and, eq, inArray } from "drizzle-orm";
import { eachDayOfInterval } from "date-fns";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";
import { readRollupMeta } from "../rollup/collect";
import {
  dayDate,
  dayKeyOf,
  monthKeyForDay,
  periodLevelOf,
  weekKeyForDay,
  yearKeyForMonth,
} from "../rollup/period";
import type { QueryTimelinePeriod } from "../schemas/query-timeline";

/**
 * The distinct week/month/year period keys that contain at least one day in
 * [rangeMin, rangeMax] (both `YYYY-MM-DD`, rangeMin <= rangeMax). Membership is
 * defined by each day's own week/month/year, so a week straddling a month
 * boundary never drags in the adjacent month. Day-level keys are never returned.
 *
 * aka: timeline rollup period keys, week/month/year keys for a date window.
 */
export function periodKeysForWindow(
  rangeMin: string,
  rangeMax: string,
): string[] {
  const keys = new Set<string>();
  for (const day of eachDayOfInterval({
    start: dayDate(rangeMin),
    end: dayDate(rangeMax),
  })) {
    const dayKey = dayKeyOf(day);
    const monthKey = monthKeyForDay(dayKey);
    keys.add(weekKeyForDay(dayKey));
    keys.add(monthKey);
    keys.add(yearKeyForMonth(monthKey));
  }
  return [...keys];
}

/**
 * Load week/month/year temporal-rollup summaries overlapping [rangeMin, rangeMax].
 *
 * Fetches the `Temporal` rollup nodes whose label is one of `periodKeysForWindow`
 * (day nodes are excluded by construction). `summary` is null until the rollup job
 * has written a real summary — detected via `additionalData.rollup` — so boilerplate
 * descriptions never surface. Only existing rollup nodes appear.
 */
export async function loadTimelinePeriods(
  db: DrizzleDB,
  userId: string,
  rangeMin: string,
  rangeMax: string,
): Promise<QueryTimelinePeriod[]> {
  const keys = periodKeysForWindow(rangeMin, rangeMax);
  if (keys.length === 0) return [];

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
        inArray(nodeMetadata.label, keys),
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
