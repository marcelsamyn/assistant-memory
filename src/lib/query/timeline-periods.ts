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
import { partitionAccessCondition } from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { MemoryAccessScope } from "~/lib/schemas/partition";
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
  partitionKey?: ContextPartitionKey,
  accessScope?: MemoryAccessScope | undefined,
): Promise<QueryTimelinePeriod[]> {
  // 1. Distinct day-node labels in range (day nodes are `YYYY-MM-DD`).
  const dayRows = await db
    .selectDistinct({ label: nodeMetadata.label })
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
      partitionKey: nodes.partitionKey,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
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
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        inArray(nodeMetadata.label, [...keys]),
      ),
    )
    .orderBy(nodeMetadata.label);

  const workspaceAggregation =
    accessScope === "workspace" && partitionKey === undefined;
  if (workspaceAggregation) {
    const rowsByKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = row.label!;
      const existing = rowsByKey.get(key);
      if (existing) existing.push(row);
      else rowsByKey.set(key, [row]);
    }

    return [...rowsByKey.entries()]
      .map(([key, keyRows]) => {
        const sortedRows = [...keyRows].sort((left, right) => {
          const leftPartition = left.partitionKey ?? "legacy";
          const rightPartition = right.partitionKey ?? "legacy";
          return (
            leftPartition.localeCompare(rightPartition) ||
            left.id.localeCompare(right.id)
          );
        });
        // This ID identifies one underlying temporal row; it is not a
        // synthetic node for the combined workspace summary.
        const representative = [...keyRows].sort((left, right) =>
          left.id.localeCompare(right.id),
        )[0]!;
        const summaries = sortedRows.flatMap((row) => {
          if (!readRollupMeta(row.additionalData) || !row.description?.trim()) {
            return [];
          }
          return [row.description];
        });
        const granularity = periodLevelOf(key);
        if (granularity === "day") return null;
        return {
          key,
          granularity,
          summary:
            summaries.length === 0
              ? null
              : summaries.length === 1
                ? summaries[0]!
                : summaries
                    .map((summary, index) => `Summary ${index + 1}: ${summary}`)
                    .join("\n"),
          temporalNodeId: representative.id,
        };
      })
      .filter(
        (period): period is NonNullable<typeof period> => period !== null,
      );
  }

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
