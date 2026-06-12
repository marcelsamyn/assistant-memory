/**
 * Temporal rollup sweep (see
 * docs/superpowers/specs/2026-06-12-temporal-rollup-design.md).
 *
 * Catch-up semantics: discover days touched by OCCURRED_ON claims since
 * the per-user watermark, expand to ancestor periods, union the pending
 * set, then summarize completed periods bottom-up within an LLM-call
 * budget. Never scheduled internally — triggered via POST /rollup.
 */
import {
  ancestorKeysForDay,
  dayKeyOf,
  isDayKey,
  isPeriodComplete,
  periodEndDayKey,
  sortForProcessing,
} from "../rollup/period";
import { ensureRollupSource } from "../rollup/source";
import { summarizePeriod } from "../rollup/summarize-period";
import { and, eq, gt, max, type SQL } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, rollupState } from "~/db/schema";
import { createCompletionClient } from "~/lib/ai";

export interface RunRollupParams {
  db: DrizzleDB;
  userId: string;
  /** Hard cap on LLM calls this sweep (fingerprint skips are free). */
  maxLlmCalls: number;
  /** History floor: periods ending before this day key are excluded. */
  startDate?: string | undefined;
  /** Test seam for completeness checks; defaults to the real today. */
  todayKey?: string | undefined;
}

export interface RollupJobResult {
  summarized: number;
  skippedUnchanged: number;
  skippedEmpty: number;
  failed: number;
  /** Periods left in pendingPeriods (incomplete, over budget, or failed). */
  deferred: number;
}

export async function runRollup({
  db,
  userId,
  maxLlmCalls,
  startDate,
  todayKey = dayKeyOf(new Date()),
}: RunRollupParams): Promise<RollupJobResult> {
  const [state] = await db
    .select()
    .from(rollupState)
    .where(eq(rollupState.userId, userId))
    .limit(1);

  // 1. Discover: day labels touched by active OCCURRED_ON claims since
  //    the watermark (all claims on the first sweep).
  const conditions: SQL[] = [
    eq(claims.userId, userId),
    eq(claims.predicate, "OCCURRED_ON"),
    eq(claims.status, "active"),
    eq(nodes.nodeType, "Temporal"),
  ];
  if (state?.watermark) {
    conditions.push(gt(claims.createdAt, state.watermark));
  }
  // Aggregated per day label: a heavy day (hundreds of claims) must not
  // materialize one row per claim on a first, watermark-less sweep.
  const touched = await db
    .select({
      dayLabel: nodeMetadata.label,
      maxClaimCreatedAt: max(claims.createdAt),
    })
    .from(claims)
    .innerJoin(nodes, eq(nodes.id, claims.objectNodeId))
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(...conditions))
    .groupBy(nodeMetadata.label);

  let watermark = state?.watermark ?? null;
  const touchedDayKeys = new Set<string>();
  for (const row of touched) {
    if (row.maxClaimCreatedAt && (!watermark || row.maxClaimCreatedAt > watermark)) {
      watermark = row.maxClaimCreatedAt;
    }
    if (row.dayLabel && isDayKey(row.dayLabel)) {
      touchedDayKeys.add(row.dayLabel);
    }
  }

  // 2. Expand to ancestors; union the carried-over pending set.
  const workSet = new Set<string>(state?.pendingPeriods ?? []);
  for (const dayKey of touchedDayKeys) {
    workSet.add(dayKey);
    for (const ancestor of ancestorKeysForDay(dayKey)) {
      workSet.add(ancestor);
    }
  }

  // 3. Filter: startDate floor excludes outright (incl. purging pending);
  //    incomplete periods are deferred until they end.
  const pending = new Set<string>();
  const ready: string[] = [];
  for (const key of workSet) {
    if (startDate !== undefined && periodEndDayKey(key) < startDate) continue;
    if (!isPeriodComplete(key, todayKey)) {
      pending.add(key);
      continue;
    }
    ready.push(key);
  }

  // 4. Process bottom-up, oldest first, within budget. A failing period
  //    is logged, left pending, and must not block the rest.
  const result: RollupJobResult = {
    summarized: 0,
    skippedUnchanged: 0,
    skippedEmpty: 0,
    failed: 0,
    deferred: 0,
  };
  let budget = maxLlmCalls;
  const client = await createCompletionClient(userId, {
    task: "temporal_summary",
  });
  const rollupSourceId = await ensureRollupSource(db, userId);

  for (const periodKey of sortForProcessing(ready)) {
    if (budget <= 0) {
      pending.add(periodKey);
      continue;
    }
    try {
      const outcome = await summarizePeriod({
        db,
        userId,
        periodKey,
        client,
        rollupSourceId,
      });
      if (outcome === "summarized") {
        budget -= 1;
        result.summarized += 1;
      } else if (outcome === "skipped-unchanged") {
        result.skippedUnchanged += 1;
      } else {
        result.skippedEmpty += 1;
      }
    } catch (error) {
      console.error(
        `Rollup: failed to summarize ${periodKey} for user ${userId}:`,
        error,
      );
      pending.add(periodKey);
      result.failed += 1;
    }
  }
  result.deferred = pending.size;

  // 5. Commit state. The watermark always advances; pending carries the
  //    deferred work.
  const pendingPeriods = [...pending].sort();
  await db
    .insert(rollupState)
    .values({
      userId,
      watermark,
      pendingPeriods,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: rollupState.userId,
      set: { watermark, pendingPeriods, updatedAt: new Date() },
    });

  return result;
}
