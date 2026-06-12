/**
 * Deterministic input assembly for temporal rollup summaries.
 *
 * Pure builders turn child rows into the exact prompt-input text; the
 * sha256 of that text is the period's staleness fingerprint (input
 * unchanged → fingerprint match → no LLM call). Thin DB fetchers load
 * the child rows. No LLM calls happen here.
 *
 * Aliases for search: rollup input collection, compaction, period
 * fingerprint, day entries.
 */
import { monthKeysOfYear, weekDayKeys, weeksOverlappingMonth } from "./period";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

/** Initial caps — tunable. Bounds even heavy days (e.g. screenpipe docs). */
export const DAY_ENTRY_MAX_CHARS = 600;
export const DAY_INPUT_MAX_CHARS = 24_000;

export function fingerprintOf(inputText: string): string {
  return createHash("sha256").update(inputText, "utf8").digest("hex");
}

export interface RollupMeta {
  fingerprint: string;
  summarizedAt: string;
}

/** Defensive read of `nodeMetadata.additionalData.rollup`. */
export function readRollupMeta(additionalData: unknown): RollupMeta | null {
  if (
    !additionalData ||
    typeof additionalData !== "object" ||
    Array.isArray(additionalData)
  ) {
    return null;
  }
  const rollup = (additionalData as Record<string, unknown>)["rollup"];
  if (!rollup || typeof rollup !== "object" || Array.isArray(rollup)) {
    return null;
  }
  const { fingerprint, summarizedAt } = rollup as Record<string, unknown>;
  if (typeof fingerprint !== "string" || typeof summarizedAt !== "string") {
    return null;
  }
  return { fingerprint, summarizedAt };
}

// --- Pure builders ---

export interface DayEntry {
  nodeType: string;
  label: string | null;
  description: string | null;
  createdAt: Date;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildDayInputText(
  dayKey: string,
  entries: DayEntry[],
): string | null {
  const usable = entries
    .filter((e) => e.label !== null || e.description !== null)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (usable.length === 0) return null;

  const lines = usable.map((e) =>
    truncate(
      `- [${e.nodeType}] ${e.label ?? "(unlabeled)"}${
        e.description ? `: ${e.description}` : ""
      }`,
      DAY_ENTRY_MAX_CHARS,
    ),
  );

  // Keep the newest lines under the total cap; render chronologically.
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (total + line.length + 1 > DAY_INPUT_MAX_CHARS) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  const dropped = lines.length - kept.length;

  return [
    `Day: ${dayKey}`,
    ...(dropped > 0 ? [`(${dropped} older entries omitted for length)`] : []),
    ...kept,
  ].join("\n");
}

export interface ChildSummary {
  key: string;
  summary: string | null;
}

export function buildWeekInputText(
  weekKey: string,
  days: ChildSummary[],
): string | null {
  if (days.every((d) => d.summary === null)) return null;
  const lines = days.map(
    (d) => `${d.key}: ${d.summary ?? "(no summarized activity)"}`,
  );
  return [`Week: ${weekKey}`, ...lines].join("\n\n");
}

export interface WeekSummaryInMonth {
  weekKey: string;
  summary: string | null;
  dayKeysInMonth: string[];
}

export function buildMonthInputText(
  monthKey: string,
  weeks: WeekSummaryInMonth[],
): string | null {
  if (weeks.every((w) => w.summary === null)) return null;
  const lines = weeks.map((w) => {
    const partial =
      w.dayKeysInMonth.length > 0 && w.dayKeysInMonth.length < 7
        ? ` (only ${w.dayKeysInMonth[0]} to ${w.dayKeysInMonth[w.dayKeysInMonth.length - 1]} fall in this month)`
        : "";
    return `${w.weekKey}${partial}: ${w.summary ?? "(no summarized activity)"}`;
  });
  return [`Month: ${monthKey}`, ...lines].join("\n\n");
}

export function buildYearInputText(
  yearKey: string,
  months: ChildSummary[],
): string | null {
  if (months.every((m) => m.summary === null)) return null;
  const lines = months.map(
    (m) => `${m.key}: ${m.summary ?? "(no summarized activity)"}`,
  );
  return [`Year: ${yearKey}`, ...lines].join("\n\n");
}

// --- DB fetchers (exercised by the summarize-period and rollup job tests) ---

export interface TemporalNodeRow {
  nodeId: TypeId<"node">;
  label: string;
  description: string | null;
  additionalData: unknown;
}

/** Fetch the user's Temporal nodes for the given period-key labels. */
export async function fetchTemporalNodesByLabels(
  db: DrizzleDB,
  userId: string,
  labels: string[],
): Promise<Map<string, TemporalNodeRow>> {
  if (labels.length === 0) return new Map();
  const rows = await db
    .select({
      nodeId: nodes.id,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, "Temporal"),
        inArray(nodeMetadata.label, labels),
      ),
    );
  return new Map(
    rows
      .filter((r): r is typeof r & { label: string } => r.label !== null)
      .map((r) => [r.label, r]),
  );
}

/**
 * A child period's summary counts only when the rollup marker is present —
 * `description` alone may be the "Represents the …" boilerplate.
 */
function summarizedDescriptionOf(
  row: TemporalNodeRow | undefined,
): string | null {
  if (!row) return null;
  return readRollupMeta(row.additionalData) ? row.description : null;
}

/** Content entries linked to a day node via active OCCURRED_ON claims. */
export async function fetchDayEntries(
  db: DrizzleDB,
  userId: string,
  dayNodeId: TypeId<"node">,
): Promise<DayEntry[]> {
  return (
    db
      .select({
        nodeType: nodes.nodeType,
        label: nodeMetadata.label,
        description: nodeMetadata.description,
        createdAt: nodes.createdAt,
      })
      .from(claims)
      .innerJoin(nodes, eq(nodes.id, claims.subjectNodeId))
      .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(claims.userId, userId),
          eq(claims.objectNodeId, dayNodeId),
          eq(claims.predicate, "OCCURRED_ON"),
          eq(claims.status, "active"),
        ),
      )
      // Stable order even for same-millisecond rows: createdAt ties would
      // otherwise flip with heap order and churn the input fingerprint,
      // causing spurious paid LLM re-summarizations.
      .orderBy(nodes.createdAt, nodes.id)
  );
}

export interface CollectedInput {
  inputText: string;
  /** Existing child period nodes — used to ensure PART_OF claims. */
  childNodeIds: TypeId<"node">[];
}

/**
 * Assemble the full prompt input for a period. Returns null when there is
 * nothing to summarize (no content for a day; no summarized children for
 * week/month/year).
 */
export async function collectPeriodInput(
  db: DrizzleDB,
  userId: string,
  periodKey: string,
  level: "day" | "week" | "month" | "year",
): Promise<CollectedInput | null> {
  if (level === "day") {
    const dayNode = (
      await fetchTemporalNodesByLabels(db, userId, [periodKey])
    ).get(periodKey);
    if (!dayNode) return null;
    const entries = await fetchDayEntries(db, userId, dayNode.nodeId);
    const inputText = buildDayInputText(periodKey, entries);
    return inputText ? { inputText, childNodeIds: [] } : null;
  }

  if (level === "week") {
    const dayKeys = weekDayKeys(periodKey);
    const dayNodes = await fetchTemporalNodesByLabels(db, userId, dayKeys);
    const inputText = buildWeekInputText(
      periodKey,
      dayKeys.map((key) => ({
        key,
        summary: summarizedDescriptionOf(dayNodes.get(key)),
      })),
    );
    if (!inputText) return null;
    return {
      inputText,
      childNodeIds: dayKeys
        .map((key) => dayNodes.get(key)?.nodeId)
        .filter((id): id is TypeId<"node"> => id !== undefined),
    };
  }

  if (level === "month") {
    const weeks = weeksOverlappingMonth(periodKey);
    const weekNodes = await fetchTemporalNodesByLabels(
      db,
      userId,
      weeks.map((w) => w.weekKey),
    );
    const inputText = buildMonthInputText(
      periodKey,
      weeks.map((w) => ({
        weekKey: w.weekKey,
        summary: summarizedDescriptionOf(weekNodes.get(w.weekKey)),
        dayKeysInMonth: w.dayKeysInMonth,
      })),
    );
    if (!inputText) return null;
    return {
      inputText,
      childNodeIds: weeks
        .map((w) => weekNodes.get(w.weekKey)?.nodeId)
        .filter((id): id is TypeId<"node"> => id !== undefined),
    };
  }

  const monthKeys = monthKeysOfYear(periodKey);
  const monthNodes = await fetchTemporalNodesByLabels(db, userId, monthKeys);
  const inputText = buildYearInputText(
    periodKey,
    monthKeys.map((key) => ({
      key,
      summary: summarizedDescriptionOf(monthNodes.get(key)),
    })),
  );
  if (!inputText) return null;
  return {
    inputText,
    childNodeIds: monthKeys
      .map((key) => monthNodes.get(key)?.nodeId)
      .filter((id): id is TypeId<"node"> => id !== undefined),
  };
}
