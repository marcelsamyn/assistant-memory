# Temporal Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SDK-triggered catch-up sweep that builds a recursive summary hierarchy over Temporal nodes: day (`2026-06-08`) → week (`2026-W24`) → month (`2026-06`) → year (`2026`), with watermark+fingerprint staleness tracking, a per-sweep LLM-call budget, and a `startDate` history floor.

**Spec:** `docs/superpowers/specs/2026-06-12-temporal-rollup-design.md` (read it first).

**Architecture:** Pure period math (`src/lib/rollup/period.ts`) feeds a deterministic input collector (`src/lib/rollup/collect.ts`); `summarize-period.ts` makes exactly one structured LLM call per stale period and writes the summary onto the Temporal node's `nodeMetadata.description`; the sweep job (`src/lib/jobs/rollup.ts`) discovers stale periods via a per-user claim-timestamp watermark + `pendingPeriods` set stored in a new `rollup_state` table. Triggered by `POST /rollup` → BullMQ, never scheduled internally.

**Tech Stack:** Nitro/h3, Drizzle + Postgres, BullMQ, OpenAI SDK (`parseStructuredCompletion` + `zodResponseFormat`), date-fns, Zod v4, vitest (test Postgres on port **5431**; CI does NOT run vitest — run tests locally).

**Conventions that apply to every task:**

- Package manager: `pnpm`. Run `pnpm run test -- <file> --run` (vitest), `pnpm run build:check` (tsc + structured-output check), `pnpm run lint`, `pnpm run format`.
- Commit messages: `<emoji> <type>(<scope>): <subject>` (✨ feat, ✅ test, ♻️ refactor, 📚 docs). Stage explicit paths only — never `git add -A` or `.`.
- Imports use the `~` alias for `src` (e.g. `~/db/schema`). Within `src/lib/**`, relative imports of siblings are the norm (see existing files).
- No `any`, no casts; `satisfies`/explicit types. External input through Zod.
- DB tests follow the ephemeral-database pattern from `src/lib/node.test.ts`: create a uniquely-named database in `beforeAll`, raw-SQL `CREATE TABLE` only the tables the test needs, drop in `afterAll`, skip the suite when no server is reachable.

## File structure

| File                                                       | Responsibility                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/rollup/period.ts` (+ `.test.ts`)                  | Pure period-key math: levels, parents/children, completeness, ordering                                                                    |
| `src/lib/rollup/collect.ts` (+ `.test.ts`)                 | Deterministic input assembly + compaction (pure builders), sha256 fingerprint, defensive `additionalData.rollup` reader, thin DB fetchers |
| `src/lib/rollup/source.ts` (+ `.test.ts`)                  | Per-user synthetic `"rollup"` source (for `PART_OF` claims' NOT NULL `sourceId`)                                                          |
| `src/lib/rollup/summarize-period.ts` (+ `.test.ts`)        | One period: collect → ensure node → ensure `PART_OF` claims → fingerprint check → one LLM call → write description + re-embed             |
| `src/lib/jobs/rollup.ts` (+ `.test.ts`)                    | The sweep: discovery, work-set expansion, startDate/completeness filtering, budgeted bottom-up processing, state commit                   |
| `src/lib/temporal.ts`                                      | Generalize: add `ensurePeriodNode`, make `ensureDayNode` delegate                                                                         |
| `src/lib/schemas/rollup.ts`                                | Request/response Zod schemas                                                                                                              |
| `src/routes/rollup.post.ts` (+ `src/rollup-route.test.ts`) | HTTP trigger w/ jobId dedup                                                                                                               |
| `src/db/schema.ts` + `drizzle/` migration                  | `rollup_state` table                                                                                                                      |
| `src/types/graph.ts`                                       | Add `"rollup"` to `SourceType`                                                                                                            |
| `src/utils/models.ts`, `src/utils/env.ts`                  | `temporal_summary` ModelTask + `MODEL_ID_TEMPORAL_SUMMARY`                                                                                |
| `src/lib/queues.ts`                                        | `ROLLUP_JOB_OPTIONS` + `"rollup"` worker branch                                                                                           |
| `src/sdk/memory-client.ts`, `src/sdk/index.ts`             | `rollup()` method + schema export                                                                                                         |

---

### Task 1: Period math module (pure)

**Files:**

- Create: `src/lib/rollup/period.ts`
- Test: `src/lib/rollup/period.test.ts`

Background you need: day labels are `yyyy-MM-dd` (see `ensureDayNode` in `src/lib/temporal.ts`). Weeks are ISO weeks (Monday start) keyed by ISO week-numbering year: `2026-W24`. 2026-01-01 is a Thursday, so 2026 has 53 ISO weeks and ISO W01 of 2026 runs 2025-12-29 → 2026-01-04. ISO weeks do NOT nest in months — a week can overlap two months, and the month layer consumes every overlapping week.

- [ ] **Step 1: Write the failing test**

Create `src/lib/rollup/period.test.ts`:

```typescript
import {
  ancestorKeysForDay,
  isPeriodComplete,
  monthKeyForDay,
  monthKeysForWeek,
  monthKeysOfYear,
  periodEndDayKey,
  periodLevelOf,
  sortForProcessing,
  weekDayKeys,
  weekKeyForDay,
  weeksOverlappingMonth,
  yearKeyForMonth,
} from "./period";
import { describe, expect, it } from "vitest";

describe("periodLevelOf", () => {
  it("classifies keys by shape", () => {
    expect(periodLevelOf("2026-06-08")).toBe("day");
    expect(periodLevelOf("2026-W24")).toBe("week");
    expect(periodLevelOf("2026-06")).toBe("month");
    expect(periodLevelOf("2026")).toBe("year");
  });

  it("throws on malformed keys", () => {
    expect(() => periodLevelOf("2026-6-8")).toThrow();
    expect(() => periodLevelOf("W24")).toThrow();
    expect(() => periodLevelOf("")).toThrow();
  });
});

describe("weekKeyForDay", () => {
  it("maps a mid-year Monday to its ISO week", () => {
    // 2026-06-08 is a Monday in ISO week 24 of 2026.
    expect(weekKeyForDay("2026-06-08")).toBe("2026-W24");
    expect(weekKeyForDay("2026-06-14")).toBe("2026-W24"); // its Sunday
  });

  it("assigns early-January days to the correct ISO week-numbering year", () => {
    // 2026 W01 spans 2025-12-29 .. 2026-01-04.
    expect(weekKeyForDay("2025-12-29")).toBe("2026-W01");
    expect(weekKeyForDay("2026-01-01")).toBe("2026-W01");
    // 2026 has 53 ISO weeks; W53 spans 2026-12-28 .. 2027-01-03.
    expect(weekKeyForDay("2027-01-01")).toBe("2026-W53");
  });
});

describe("weekDayKeys", () => {
  it("returns Monday..Sunday day keys", () => {
    expect(weekDayKeys("2026-W24")).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
    ]);
  });

  it("handles a year-straddling week", () => {
    expect(weekDayKeys("2026-W53")[0]).toBe("2026-12-28");
    expect(weekDayKeys("2026-W53")[6]).toBe("2027-01-03");
  });
});

describe("month/year containment", () => {
  it("maps days and months upward by prefix", () => {
    expect(monthKeyForDay("2026-06-08")).toBe("2026-06");
    expect(yearKeyForMonth("2026-06")).toBe("2026");
    expect(monthKeysOfYear("2026")).toHaveLength(12);
    expect(monthKeysOfYear("2026")[0]).toBe("2026-01");
    expect(monthKeysOfYear("2026")[11]).toBe("2026-12");
  });

  it("finds the month(s) a week overlaps", () => {
    expect(monthKeysForWeek("2026-W24")).toEqual(["2026-06"]);
    // W53 2026 straddles December 2026 and January 2027.
    expect(monthKeysForWeek("2026-W53")).toEqual(["2026-12", "2027-01"]);
  });
});

describe("weeksOverlappingMonth", () => {
  it("lists every overlapping ISO week with its in-month days", () => {
    // June 2026: Jun 1 is a Monday (W23); Jun 29-30 fall in W27.
    const weeks = weeksOverlappingMonth("2026-06");
    expect(weeks.map((w) => w.weekKey)).toEqual([
      "2026-W23",
      "2026-W24",
      "2026-W25",
      "2026-W26",
      "2026-W27",
    ]);
    const last = weeks[4]!;
    expect(last.dayKeysInMonth).toEqual(["2026-06-29", "2026-06-30"]);
    const first = weeks[0]!;
    expect(first.dayKeysInMonth).toHaveLength(7);
  });
});

describe("ancestorKeysForDay", () => {
  it("returns week, overlapping months, and their years", () => {
    expect(ancestorKeysForDay("2026-06-08")).toEqual([
      "2026-W24",
      "2026-06",
      "2026",
    ]);
  });

  it("includes both straddled months and years at a boundary", () => {
    expect(ancestorKeysForDay("2027-01-01")).toEqual([
      "2026-W53",
      "2026-12",
      "2027-01",
      "2026",
      "2027",
    ]);
  });
});

describe("periodEndDayKey / isPeriodComplete", () => {
  it("computes the period's final day", () => {
    expect(periodEndDayKey("2026-06-08")).toBe("2026-06-08");
    expect(periodEndDayKey("2026-W24")).toBe("2026-06-14");
    expect(periodEndDayKey("2026-06")).toBe("2026-06-30");
    expect(periodEndDayKey("2026-02")).toBe("2026-02-28");
    expect(periodEndDayKey("2026")).toBe("2026-12-31");
  });

  it("a period is complete only when its last day is strictly before today", () => {
    expect(isPeriodComplete("2026-W24", "2026-06-14")).toBe(false);
    expect(isPeriodComplete("2026-W24", "2026-06-15")).toBe(true);
    expect(isPeriodComplete("2026-06-14", "2026-06-15")).toBe(true);
    expect(isPeriodComplete("2026", "2026-12-31")).toBe(false);
    expect(isPeriodComplete("2026", "2027-01-01")).toBe(true);
  });
});

describe("sortForProcessing", () => {
  it("orders bottom-up by level, then oldest-first within a level", () => {
    expect(
      sortForProcessing([
        "2026",
        "2026-06",
        "2026-W24",
        "2026-06-09",
        "2026-06-08",
        "2026-W23",
      ]),
    ).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-W23",
      "2026-W24",
      "2026-06",
      "2026",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- src/lib/rollup/period.test.ts --run`
Expected: FAIL — cannot resolve `./period`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/rollup/period.ts`:

```typescript
/**
 * Pure period-key math for the temporal rollup hierarchy.
 *
 * Period keys (all derived from the day-label convention used by
 * `ensureDayNode`): day `yyyy-MM-dd`, ISO week `yyyy-Www` (ISO
 * week-numbering year), month `yyyy-MM`, year `yyyy`. All functions are
 * pure and timezone-stable: day keys are parsed and re-formatted with
 * date-fns in local time, so round-trips never shift dates.
 *
 * Aliases for search: period keys, temporal hierarchy, ISO week math,
 * rollup periods.
 */
import {
  addDays,
  format,
  getISOWeek,
  getISOWeekYear,
  lastDayOfMonth,
  parse,
  setISOWeek,
  setISOWeekYear,
  startOfISOWeek,
} from "date-fns";

export type PeriodLevel = "day" | "week" | "month" | "year";

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const YEAR_KEY_RE = /^\d{4}$/;

const REFERENCE_DATE = new Date(2000, 0, 1);

export function periodLevelOf(key: string): PeriodLevel {
  if (DAY_KEY_RE.test(key)) return "day";
  if (WEEK_KEY_RE.test(key)) return "week";
  if (MONTH_KEY_RE.test(key)) return "month";
  if (YEAR_KEY_RE.test(key)) return "year";
  throw new Error(`Malformed period key: "${key}"`);
}

export function isDayKey(key: string): boolean {
  return DAY_KEY_RE.test(key);
}

function dayDate(dayKey: string): Date {
  return parse(dayKey, "yyyy-MM-dd", REFERENCE_DATE);
}

export function dayKeyOf(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function weekKeyForDay(dayKey: string): string {
  const d = dayDate(dayKey);
  const isoYear = String(getISOWeekYear(d)).padStart(4, "0");
  const isoWeek = String(getISOWeek(d)).padStart(2, "0");
  return `${isoYear}-W${isoWeek}`;
}

function mondayOfWeek(weekKey: string): Date {
  const match = WEEK_KEY_RE.exec(weekKey);
  if (!match) throw new Error(`Malformed week key: "${weekKey}"`);
  const isoYear = Number(match[1]);
  const isoWeek = Number(match[2]);
  // Anchor mid-year so week 26 always exists before the ISO fields are set.
  let d = new Date(2000, 6, 1);
  d = setISOWeekYear(d, isoYear);
  d = setISOWeek(d, isoWeek);
  return startOfISOWeek(d);
}

export function weekDayKeys(weekKey: string): string[] {
  const monday = mondayOfWeek(weekKey);
  return Array.from({ length: 7 }, (_, i) => dayKeyOf(addDays(monday, i)));
}

export function monthKeyForDay(dayKey: string): string {
  if (!DAY_KEY_RE.test(dayKey)) {
    throw new Error(`Malformed day key: "${dayKey}"`);
  }
  return dayKey.slice(0, 7);
}

export function monthKeysForWeek(weekKey: string): string[] {
  const days = weekDayKeys(weekKey);
  return [...new Set(days.map(monthKeyForDay))];
}

export function yearKeyForMonth(monthKey: string): string {
  if (!MONTH_KEY_RE.test(monthKey)) {
    throw new Error(`Malformed month key: "${monthKey}"`);
  }
  return monthKey.slice(0, 4);
}

export function monthKeysOfYear(yearKey: string): string[] {
  if (!YEAR_KEY_RE.test(yearKey)) {
    throw new Error(`Malformed year key: "${yearKey}"`);
  }
  return Array.from(
    { length: 12 },
    (_, i) => `${yearKey}-${String(i + 1).padStart(2, "0")}`,
  );
}

export interface WeekInMonth {
  weekKey: string;
  /** The subset of this week's 7 days that fall inside the month. */
  dayKeysInMonth: string[];
}

export function weeksOverlappingMonth(monthKey: string): WeekInMonth[] {
  if (!MONTH_KEY_RE.test(monthKey)) {
    throw new Error(`Malformed month key: "${monthKey}"`);
  }
  const firstDayKey = `${monthKey}-01`;
  const lastDayKey = dayKeyOf(lastDayOfMonth(dayDate(firstDayKey)));
  const result: WeekInMonth[] = [];
  let weekKey = weekKeyForDay(firstDayKey);
  for (;;) {
    const days = weekDayKeys(weekKey);
    const dayKeysInMonth = days.filter((d) => monthKeyForDay(d) === monthKey);
    result.push({ weekKey, dayKeysInMonth });
    const sunday = days[6]!;
    if (sunday >= lastDayKey) break;
    weekKey = weekKeyForDay(dayKeyOf(addDays(dayDate(sunday), 1)));
  }
  return result;
}

/**
 * Every period whose summary input can change when this day's summary
 * changes: the day's ISO week, every month that week overlaps (a
 * boundary week feeds two month summaries), and those months' years.
 */
export function ancestorKeysForDay(dayKey: string): string[] {
  const weekKey = weekKeyForDay(dayKey);
  const monthKeys = monthKeysForWeek(weekKey);
  const yearKeys = [...new Set(monthKeys.map(yearKeyForMonth))];
  return [weekKey, ...monthKeys, ...yearKeys];
}

export function periodEndDayKey(key: string): string {
  const level = periodLevelOf(key);
  switch (level) {
    case "day":
      return key;
    case "week":
      return weekDayKeys(key)[6]!;
    case "month":
      return dayKeyOf(lastDayOfMonth(dayDate(`${key}-01`)));
    case "year":
      return `${key}-12-31`;
  }
}

/** A period is complete once its final day is strictly before today. */
export function isPeriodComplete(key: string, todayDayKey: string): boolean {
  return periodEndDayKey(key) < todayDayKey;
}

const LEVEL_ORDER: Record<PeriodLevel, number> = {
  day: 0,
  week: 1,
  month: 2,
  year: 3,
};

/** Bottom-up (day→week→month→year), oldest-first within each level. */
export function sortForProcessing(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const levelDiff =
      LEVEL_ORDER[periodLevelOf(a)] - LEVEL_ORDER[periodLevelOf(b)];
    if (levelDiff !== 0) return levelDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- src/lib/rollup/period.test.ts --run`
Expected: PASS (all describes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/rollup/period.ts src/lib/rollup/period.test.ts
git commit -m "✨ feat(rollup): pure period-key math for temporal hierarchy"
```

### Task 2: Schema groundwork — `rollup_state` table, `"rollup"` SourceType, `temporal_summary` ModelTask

**Files:**

- Modify: `src/db/schema.ts` (append after the `scratchpads` table + its relations)
- Modify: `src/types/graph.ts` (the `SourceType` union)
- Modify: `src/utils/models.ts` (ModelTask union + overrides map)
- Modify: `src/utils/env.ts` (env schema, next to the other `MODEL_ID_*` entries)
- Create: generated migration under `drizzle/` (via drizzle-kit)

Declarative schema/type changes — no behavior to TDD; the build check and migration diff are the verification.

- [ ] **Step 1: Add the `rollup_state` table to `src/db/schema.ts`**

The file uses drizzle `casing: "snake_case"` — bare property names map to snake_case columns automatically. Append after `scratchpadsRelations`:

```typescript
/**
 * Per-user temporal-rollup sweep state (see
 * docs/superpowers/specs/2026-06-12-temporal-rollup-design.md).
 *
 * `watermark`: max `claims.createdAt` whose OCCURRED_ON claims have been
 * incorporated into the work set. Always advances; deferred work is
 * carried by `pendingPeriods`, never by holding the watermark back.
 * `pendingPeriods`: period keys (day/week/month/year) awaiting
 * summarization — incomplete periods, over-budget leftovers, failures.
 */
export const rollupState = pgTable("rollup_state", {
  userId: text()
    .primaryKey()
    .notNull()
    .references(() => users.id),
  watermark: timestamp({ withTimezone: true }),
  pendingPeriods: jsonb().$type<string[]>().notNull().default([]),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});

export const rollupStateRelations = relations(rollupState, ({ one }) => ({
  user: one(users, {
    fields: [rollupState.userId],
    references: [users.id],
  }),
}));
```

- [ ] **Step 2: Add `"rollup"` to the `SourceType` union in `src/types/graph.ts`**

```typescript
export type SourceType =
  | "conversation"
  | "conversation_message"
  | "document"
  | "legacy_migration"
  | "manual"
  | "meeting_transcript"
  | "external_conversation"
  | "metric_push"
  | "metric_manual"
  | "rollup";
```

(`sources.type` is a plain `varchar(50)` — no DB change needed for this.)

- [ ] **Step 3: Add the `temporal_summary` ModelTask**

In `src/utils/models.ts`, extend the union and the overrides map:

```typescript
export type ModelTask =
  | "graph_extraction"
  | "document_spine"
  | "transcript_segmentation"
  | "conversation_summary"
  | "graph_cleanup"
  | "atlas"
  | "profile_synthesis"
  | "dream"
  | "deep_research"
  | "temporal_summary";
```

```typescript
const TASK_MODEL_OVERRIDES: Record<ModelTask, string | undefined> = {
  graph_extraction: undefined,
  document_spine: env.MODEL_ID_DOCUMENT_SPINE,
  transcript_segmentation: env.MODEL_ID_TRANSCRIPT_SEGMENTATION,
  conversation_summary: env.MODEL_ID_CONVERSATION_SUMMARY,
  graph_cleanup: env.MODEL_ID_GRAPH_CLEANUP,
  atlas: env.MODEL_ID_ATLAS,
  profile_synthesis: env.MODEL_ID_PROFILE_SYNTHESIS,
  dream: env.MODEL_ID_DREAM,
  deep_research: env.MODEL_ID_DEEP_RESEARCH,
  temporal_summary: env.MODEL_ID_TEMPORAL_SUMMARY,
};
```

In `src/utils/env.ts`, add directly under `MODEL_ID_DEEP_RESEARCH`:

```typescript
  MODEL_ID_TEMPORAL_SUMMARY: z.string().min(1).optional(),
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm run drizzle:generate`
Expected: a new file `drizzle/00XX_<name>.sql` containing `CREATE TABLE "rollup_state"` with columns `user_id` (text, PK, FK → users), `watermark` (timestamptz, nullable), `pending_periods` (jsonb, not null, default `'[]'`), `updated_at` (timestamptz, not null, default now). Inspect the SQL — it must contain ONLY the new table (no unrelated diffs). If unrelated statements appear, STOP and report BLOCKED.

- [ ] **Step 5: Build check**

Run: `pnpm run build:check`
Expected: clean exit (tsc + structured-output check).

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/types/graph.ts src/utils/models.ts src/utils/env.ts drizzle/
git commit -m "✨ feat(rollup): rollup_state table, rollup source type, temporal_summary task"
```

---

### Task 3: Per-user synthetic rollup source

**Files:**

- Create: `src/lib/rollup/source.ts`
- Test: `src/lib/rollup/source.test.ts`

`claims.sourceId` is NOT NULL, so the `PART_OF` containment claims need a source. One idempotent synthetic source per user, modeled on `src/lib/metrics/sources.ts` (which relies on the existing `sources` unique constraint on `(user_id, type, external_id)`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/rollup/source.test.ts`:

```typescript
import { ensureRollupSource } from "./source";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

describeIfServer("ensureRollupSource", () => {
  const dbName = `memory_rollup_source_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(`
      CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
      CREATE TABLE "sources" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "type" varchar(50) NOT NULL,
        "external_id" text NOT NULL,
        "parent_source" text,
        "scope" varchar(16) DEFAULT 'personal' NOT NULL,
        "metadata" jsonb,
        "last_ingested_at" timestamp with time zone,
        "status" varchar(20) DEFAULT 'pending',
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "deleted_at" timestamp with time zone,
        "content_type" varchar(100),
        "content_length" integer,
        CONSTRAINT "sources_user_type_external_unique"
          UNIQUE ("user_id", "type", "external_id")
      );
    `);
    await client.query(`INSERT INTO "users" ("id") VALUES ('user_rollup')`);
  });

  afterAll(async () => {
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("creates the source once and returns the same id thereafter", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });

    const first = await ensureRollupSource(db, "user_rollup");
    const second = await ensureRollupSource(db, "user_rollup");
    expect(second).toBe(first);

    const rows = await client.query(
      `SELECT "type", "external_id", "status" FROM "sources" WHERE "user_id" = 'user_rollup'`,
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      type: "rollup",
      external_id: "rollup",
      status: "completed",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- src/lib/rollup/source.test.ts --run`
Expected: FAIL — cannot resolve `./source`. (If it reports the whole suite skipped, the test Postgres on :5431 isn't running — start it with `docker compose up -d` first.)

- [ ] **Step 3: Write the implementation**

Create `src/lib/rollup/source.ts`:

```typescript
/**
 * Synthetic per-user source backing rollup-generated PART_OF claims
 * (`claims.sourceId` is NOT NULL and containment claims have no natural
 * ingestion source). Mirrors the metric-source pattern in
 * `src/lib/metrics/sources.ts`.
 */
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

const ROLLUP_EXTERNAL_ID = "rollup";

export async function ensureRollupSource(
  db: DrizzleDB,
  userId: string,
): Promise<TypeId<"source">> {
  const [inserted] = await db
    .insert(sources)
    .values({
      userId,
      type: "rollup",
      externalId: ROLLUP_EXTERNAL_ID,
      scope: "personal",
      status: "completed",
    })
    .onConflictDoNothing()
    .returning({ id: sources.id });
  if (inserted) return inserted.id;

  const [existing] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.type, "rollup"),
        eq(sources.externalId, ROLLUP_EXTERNAL_ID),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`Failed to ensure rollup source for user ${userId}`);
  }
  return existing.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- src/lib/rollup/source.test.ts --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rollup/source.ts src/lib/rollup/source.test.ts
git commit -m "✨ feat(rollup): per-user synthetic rollup source"
```

### Task 4: `ensurePeriodNode` (generalize `ensureDayNode`)

**Files:**

- Modify: `src/lib/temporal.ts`
- Test: `src/lib/temporal.test.ts` (new)

`ensureDayNode` (currently in `src/lib/temporal.ts`) finds/creates a `Temporal` node by `nodeMetadata.label`. Generalize it: `ensurePeriodNode(db, userId, periodKey)` handles all four levels; `ensureDayNode` becomes a thin delegate so all existing callers keep working unchanged.

- [ ] **Step 1: Write the failing test**

Create `src/lib/temporal.test.ts`:

```typescript
import { ensureDayNode, ensurePeriodNode } from "./temporal";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  resetTestOverrides,
  setSkipEmbeddingPersistence,
} from "~/utils/test-overrides";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

describeIfServer("ensurePeriodNode", () => {
  const dbName = `memory_temporal_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;

  beforeAll(async () => {
    setSkipEmbeddingPersistence(true);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(`
      CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
      CREATE TABLE "nodes" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "node_type" varchar(50) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE "node_metadata" (
        "id" text PRIMARY KEY NOT NULL,
        "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
        "label" text,
        "canonical_label" text,
        "description" text,
        "additional_data" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
      );
    `);
    await client.query(`INSERT INTO "users" ("id") VALUES ('user_t')`);
  });

  afterAll(async () => {
    resetTestOverrides();
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("creates a Temporal node per period key and is idempotent", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });

    const weekId = await ensurePeriodNode(db, "user_t", "2026-W24");
    const weekIdAgain = await ensurePeriodNode(db, "user_t", "2026-W24");
    expect(weekIdAgain).toBe(weekId);

    const monthId = await ensurePeriodNode(db, "user_t", "2026-06");
    const yearId = await ensurePeriodNode(db, "user_t", "2026");
    expect(new Set([weekId, monthId, yearId]).size).toBe(3);

    const rows = await client.query(
      `SELECT m."label", m."description", n."node_type"
       FROM "node_metadata" m JOIN "nodes" n ON n."id" = m."node_id"
       WHERE n."user_id" = 'user_t' ORDER BY m."label"`,
    );
    expect(rows.rows).toEqual([
      {
        label: "2026",
        description: "Represents the year 2026",
        node_type: "Temporal",
      },
      {
        label: "2026-06",
        description: "Represents the month 2026-06",
        node_type: "Temporal",
      },
      {
        label: "2026-W24",
        description: "Represents the week 2026-W24",
        node_type: "Temporal",
      },
    ]);
  });

  it("ensureDayNode delegates and stays label-compatible", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const viaDate = await ensureDayNode(db, "user_t", new Date(2026, 5, 8));
    const viaKey = await ensurePeriodNode(db, "user_t", "2026-06-08");
    expect(viaKey).toBe(viaDate);
  });

  it("rejects malformed period keys", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    await expect(ensurePeriodNode(db, "user_t", "junk")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- src/lib/temporal.test.ts --run`
Expected: FAIL — `ensurePeriodNode` is not exported.

- [ ] **Step 3: Refactor `src/lib/temporal.ts`**

Replace the whole file body (keeping the existing imports, adding `periodLevelOf`/`PeriodLevel` from the rollup period module):

```typescript
import { generateEmbeddings } from "./embeddings";
import { periodLevelOf, type PeriodLevel } from "./rollup/period";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import { type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "~/db/schema";
import { nodeEmbeddings, nodeMetadata, nodes } from "~/db/schema";
import { NodeTypeEnum } from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

type Database = NodePgDatabase<typeof schema>;

const PERIOD_DESCRIPTION: Record<PeriodLevel, (key: string) => string> = {
  day: (key) => `Represents the day ${key}`,
  week: (key) => `Represents the week ${key}`,
  month: (key) => `Represents the month ${key}`,
  year: (key) => `Represents the year ${key}`,
};

/**
 * Ensures a Temporal node representing the given date exists for the user,
 * creating one if necessary.
 *
 * @returns The TypeId of the existing or newly created day node.
 */
export async function ensureDayNode(
  db: Database,
  userId: string,
  targetDate: Date = new Date(),
): Promise<TypeId<"node">> {
  return ensurePeriodNode(db, userId, format(targetDate, "yyyy-MM-dd"));
}

/**
 * Ensures a Temporal node for any rollup period key (day `yyyy-MM-dd`,
 * week `yyyy-Www`, month `yyyy-MM`, year `yyyy`) exists for the user.
 * Lookup is by `nodeMetadata.label` — the period key IS the label.
 *
 * @throws Error on a malformed key, embedding failure, or insert failure.
 */
export async function ensurePeriodNode(
  db: Database,
  userId: string,
  periodKey: string,
): Promise<TypeId<"node">> {
  const level = periodLevelOf(periodKey);

  const [existingNode] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
        eq(nodeMetadata.label, periodKey),
      ),
    )
    .limit(1);

  if (existingNode) {
    return existingNode.id;
  }

  const nodeDescription = PERIOD_DESCRIPTION[level](periodKey);
  const skipEmbedding = shouldSkipEmbeddingPersistence();

  const nodeEmbedding = skipEmbedding
    ? null
    : await generatePeriodNodeEmbedding(periodKey, nodeDescription);

  try {
    const [insertedNode] = await db
      .insert(nodes)
      .values({
        userId,
        nodeType: NodeTypeEnum.enum.Temporal,
      })
      .returning({ id: nodes.id });

    if (!insertedNode) {
      throw new Error(
        `Failed to retrieve ID after inserting period node: ${periodKey}`,
      );
    }

    const actualNodeId = insertedNode.id;

    await db.transaction(async (tx) => {
      await tx.insert(nodeMetadata).values({
        nodeId: actualNodeId,
        label: periodKey,
        description: nodeDescription,
      });
      if (nodeEmbedding) {
        await tx.insert(nodeEmbeddings).values({
          nodeId: actualNodeId,
          embedding: nodeEmbedding,
          modelName: "jina-embeddings-v3",
        });
      }
    });

    return actualNodeId;
  } catch (error) {
    console.error(`Failed to create period node ${periodKey}:`, error);
    throw new Error(`Database operation failed for period node ${periodKey}`);
  }
}

async function generatePeriodNodeEmbedding(
  periodKey: string,
  nodeDescription: string,
): Promise<number[]> {
  const embeddingContent = `${periodKey}: ${nodeDescription}`;
  const embeddingsResult = await generateEmbeddings({
    input: [embeddingContent],
    model: "jina-embeddings-v3",
    truncate: true,
  });

  const embedding = embeddingsResult?.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error(
      `Failed to generate valid embedding for period node: ${periodKey}`,
    );
  }
  return embedding;
}
```

Note: the old `generateDayNodeEmbedding` is renamed to `generatePeriodNodeEmbedding`; behavior for day nodes is byte-identical (same lookup, same description text, same embedding content).

- [ ] **Step 4: Run tests — new file AND existing suites that exercise `ensureDayNode`**

Run: `pnpm run test -- src/lib/temporal.test.ts src/lib/node.test.ts --run`
Expected: PASS. Then `pnpm run build:check` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/temporal.ts src/lib/temporal.test.ts
git commit -m "♻️ refactor(temporal): generalize ensureDayNode into ensurePeriodNode"
```

---

### Task 5: Input builders, compaction, fingerprint (pure) + DB fetchers

**Files:**

- Create: `src/lib/rollup/collect.ts`
- Test: `src/lib/rollup/collect.test.ts` (pure builders only — the DB fetchers are exercised by Tasks 6–7's integration tests)

- [ ] **Step 1: Write the failing test**

Create `src/lib/rollup/collect.test.ts`:

```typescript
import {
  DAY_ENTRY_MAX_CHARS,
  DAY_INPUT_MAX_CHARS,
  buildDayInputText,
  buildMonthInputText,
  buildWeekInputText,
  buildYearInputText,
  fingerprintOf,
  readRollupMeta,
} from "./collect";
import { describe, expect, it } from "vitest";

describe("fingerprintOf", () => {
  it("is a stable sha256 hex of the input", () => {
    expect(fingerprintOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(fingerprintOf("abc")).toBe(fingerprintOf("abc"));
    expect(fingerprintOf("abc")).not.toBe(fingerprintOf("abd"));
  });
});

describe("readRollupMeta", () => {
  it("reads a valid rollup marker", () => {
    expect(
      readRollupMeta({ rollup: { fingerprint: "f1", summarizedAt: "t1" } }),
    ).toEqual({ fingerprint: "f1", summarizedAt: "t1" });
  });

  it("returns null for anything else", () => {
    expect(readRollupMeta(null)).toBeNull();
    expect(readRollupMeta(undefined)).toBeNull();
    expect(readRollupMeta({})).toBeNull();
    expect(readRollupMeta({ rollup: { fingerprint: 42 } })).toBeNull();
    expect(readRollupMeta([])).toBeNull();
    expect(readRollupMeta("rollup")).toBeNull();
  });
});

describe("buildDayInputText", () => {
  const entry = (label: string, description: string | null) => ({
    nodeType: "Conversation",
    label,
    description,
    createdAt: new Date("2026-06-08T10:00:00Z"),
  });

  it("returns null when there are no usable entries", () => {
    expect(buildDayInputText("2026-06-08", [])).toBeNull();
    expect(
      buildDayInputText("2026-06-08", [
        {
          nodeType: "Event",
          label: null,
          description: null,
          createdAt: new Date(0),
        },
      ]),
    ).toBeNull();
  });

  it("renders one capped line per entry, chronologically", () => {
    const text = buildDayInputText("2026-06-08", [
      entry("Standup", "Discussed the rollout plan with Sam."),
      entry("Gym session", null),
    ]);
    expect(text).toContain("Day: 2026-06-08");
    expect(text).toContain(
      "- [Conversation] Standup: Discussed the rollout plan with Sam.",
    );
    expect(text).toContain("- [Conversation] Gym session");
  });

  it("truncates an oversize entry to the per-entry cap", () => {
    const text = buildDayInputText("2026-06-08", [
      entry("Long", "x".repeat(DAY_ENTRY_MAX_CHARS * 2)),
    ]);
    const line = text!.split("\n").find((l) => l.startsWith("- "));
    expect(line!.length).toBeLessThanOrEqual(DAY_ENTRY_MAX_CHARS);
  });

  it("drops oldest entries beyond the total cap and says so", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      nodeType: "Document",
      label: `Doc ${String(i).padStart(3, "0")}`,
      description: "y".repeat(500),
      createdAt: new Date(2026, 5, 8, 0, i),
    }));
    const text = buildDayInputText("2026-06-08", entries);
    expect(text!.length).toBeLessThanOrEqual(DAY_INPUT_MAX_CHARS + 200);
    expect(text).toContain("older entries omitted");
    // newest entry survives, oldest is dropped
    expect(text).toContain("Doc 099");
    expect(text).not.toContain("Doc 000");
  });
});

describe("buildWeekInputText", () => {
  it("returns null when no day has a summary", () => {
    expect(
      buildWeekInputText("2026-W24", [
        { key: "2026-06-08", summary: null },
        { key: "2026-06-09", summary: null },
      ]),
    ).toBeNull();
  });

  it("lists each day with its summary or a no-activity marker", () => {
    const text = buildWeekInputText("2026-W24", [
      { key: "2026-06-08", summary: "Shipped the rollup spec." },
      { key: "2026-06-09", summary: null },
    ]);
    expect(text).toContain("Week: 2026-W24");
    expect(text).toContain("2026-06-08: Shipped the rollup spec.");
    expect(text).toContain("2026-06-09: (no summarized activity)");
  });
});

describe("buildMonthInputText", () => {
  it("annotates boundary weeks with their in-month days", () => {
    const text = buildMonthInputText("2026-06", [
      {
        weekKey: "2026-W23",
        summary: "Full week in June.",
        dayKeysInMonth: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
          "2026-06-06",
          "2026-06-07",
        ],
      },
      {
        weekKey: "2026-W27",
        summary: "Straddles into July.",
        dayKeysInMonth: ["2026-06-29", "2026-06-30"],
      },
    ]);
    expect(text).toContain("Month: 2026-06");
    expect(text).toContain("2026-W23: Full week in June.");
    expect(text).toContain(
      "2026-W27 (only 2026-06-29 to 2026-06-30 fall in this month): Straddles into July.",
    );
  });

  it("returns null when no week has a summary", () => {
    expect(
      buildMonthInputText("2026-06", [
        { weekKey: "2026-W23", summary: null, dayKeysInMonth: [] },
      ]),
    ).toBeNull();
  });
});

describe("buildYearInputText", () => {
  it("lists months with summaries or markers, null when empty", () => {
    expect(
      buildYearInputText("2026", [{ key: "2026-01", summary: null }]),
    ).toBeNull();
    const text = buildYearInputText("2026", [
      { key: "2026-01", summary: "January arc." },
      { key: "2026-02", summary: null },
    ]);
    expect(text).toContain("Year: 2026");
    expect(text).toContain("2026-01: January arc.");
    expect(text).toContain("2026-02: (no summarized activity)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- src/lib/rollup/collect.test.ts --run`
Expected: FAIL — cannot resolve `./collect`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/rollup/collect.ts`:

```typescript
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
  return db
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- src/lib/rollup/collect.test.ts --run`
Expected: PASS. Then `pnpm run build:check` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rollup/collect.ts src/lib/rollup/collect.test.ts
git commit -m "✨ feat(rollup): deterministic input builders, compaction, fingerprint"
```

### Task 6: `summarizePeriod` — one period, one LLM call

**Files:**

- Create: `src/lib/rollup/summarize-period.ts`
- Test: `src/lib/rollup/summarize-period.test.ts`

Flow per period: collect input → ensure period node → ensure `PART_OF` claims for existing children (before the fingerprint gate, so re-runs repair missing edges) → fingerprint match? skip : one `parseStructuredCompletion` call → write `description` + `additionalData.rollup` → re-embed (unless `shouldSkipEmbeddingPersistence()`).

LLM mocking uses the existing production seam: `createCompletionClient` returns `getExtractionClientOverride()` when set (see `src/lib/ai.ts` / `src/utils/test-overrides.ts`) — no vitest module mocks needed.

- [ ] **Step 1: Write the failing test**

Create `src/lib/rollup/summarize-period.test.ts`:

```typescript
import { ensureRollupSource } from "./source";
import { summarizePeriod } from "./summarize-period";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { createCompletionClient } from "~/lib/ai";
import { ensurePeriodNode } from "~/lib/temporal";
import { newTypeId } from "~/types/typeid";
import {
  resetTestOverrides,
  setExtractionClientOverride,
  setSkipEmbeddingPersistence,
  type StubCompletionClient,
} from "~/utils/test-overrides";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

/** All tables the rollup write path touches (embeddings are skipped). */
export const ROLLUP_TEST_TABLES_SQL = `
  CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
  CREATE TABLE "nodes" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "node_type" varchar(50) NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE "node_metadata" (
    "id" text PRIMARY KEY NOT NULL,
    "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
    "label" text,
    "canonical_label" text,
    "description" text,
    "additional_data" jsonb,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
  );
  CREATE TABLE "sources" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "type" varchar(50) NOT NULL,
    "external_id" text NOT NULL,
    "parent_source" text,
    "scope" varchar(16) DEFAULT 'personal' NOT NULL,
    "metadata" jsonb,
    "last_ingested_at" timestamp with time zone,
    "status" varchar(20) DEFAULT 'pending',
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "deleted_at" timestamp with time zone,
    "content_type" varchar(100),
    "content_length" integer,
    CONSTRAINT "sources_user_type_external_unique"
      UNIQUE ("user_id", "type", "external_id")
  );
  CREATE TABLE "claims" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
    "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
    "object_value" text,
    "predicate" varchar(80) NOT NULL,
    "statement" text NOT NULL,
    "description" text,
    "metadata" jsonb,
    "object_instant" timestamp with time zone,
    "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
    "scope" varchar(16) DEFAULT 'personal' NOT NULL,
    "asserted_by_kind" varchar(24) NOT NULL,
    "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
    "superseded_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
    "contradicted_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
    "stated_at" timestamp with time zone NOT NULL,
    "valid_from" timestamp with time zone,
    "valid_to" timestamp with time zone,
    "status" varchar(30) DEFAULT 'active' NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE "rollup_state" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id"),
    "watermark" timestamp with time zone,
    "pending_periods" jsonb DEFAULT '[]' NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
`;

/** Stub LLM client that records prompts and returns canned summaries. */
export function stubLlm(): {
  client: StubCompletionClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    chat: {
      completions: {
        parse: async (body: { messages: Array<{ content: string }> }) => {
          const prompt = body.messages.map((m) => m.content).join("\n");
          calls.push(prompt);
          return {
            choices: [
              {
                message: {
                  parsed: { summary: `LLM summary #${calls.length}` },
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  } as unknown as StubCompletionClient;
  return { client, calls };
}

describeIfServer("summarizePeriod", () => {
  const dbName = `memory_summarize_period_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  const userId = "user_sp";
  let client: Client;

  beforeAll(async () => {
    setSkipEmbeddingPersistence(true);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(ROLLUP_TEST_TABLES_SQL);
    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  });

  afterAll(async () => {
    resetTestOverrides();
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("skips a day with no linked content", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    const outcome = await summarizePeriod({
      db,
      userId,
      periodKey: "2026-01-05",
      client: openai,
      rollupSourceId,
    });
    expect(outcome).toBe("skipped-empty");
  });

  it("summarizes a day with content, then fingerprint-skips a re-run", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    // Seed: a day node + one content node linked via OCCURRED_ON.
    const dayNodeId = await ensurePeriodNode(db, userId, "2026-01-06");
    const contentNodeId = newTypeId("node");
    const contentSourceId = newTypeId("source");
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
       VALUES ($1, $2, 'conversation', 'conv-1')`,
      [contentSourceId, userId],
    );
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Conversation')`,
      [contentNodeId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "description")
       VALUES ($1, $2, 'Standup', 'Talked about rollups with Sam.')`,
      [newTypeId("node_metadata"), contentNodeId],
    );
    await client.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_node_id", "predicate",
        "statement", "source_id", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, $4, 'OCCURRED_ON', 'occurred', $5, 'system', now())`,
      [newTypeId("claim"), userId, contentNodeId, dayNodeId, contentSourceId],
    );

    const params = {
      db,
      userId,
      periodKey: "2026-01-06",
      client: openai,
      rollupSourceId,
    };
    expect(await summarizePeriod(params)).toBe("summarized");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Standup");

    const meta = await client.query(
      `SELECT m."description", m."additional_data" FROM "node_metadata" m
       WHERE m."node_id" = $1`,
      [dayNodeId],
    );
    expect(meta.rows[0].description).toBe("LLM summary #1");
    expect(meta.rows[0].additional_data.rollup.fingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    );

    // Unchanged input → no second LLM call.
    expect(await summarizePeriod(params)).toBe("skipped-unchanged");
    expect(calls).toHaveLength(1);
  });

  it("summarizes a week from day summaries and ensures PART_OF claims idempotently", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    // 2026-01-06 already has a summarized day node from the previous test.
    const params = {
      db,
      userId,
      periodKey: "2026-W02", // Jan 5–11 2026
      client: openai,
      rollupSourceId,
    };
    expect(await summarizePeriod(params)).toBe("summarized");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("2026-01-06: LLM summary");
    expect(calls[0]).toContain("(no summarized activity)");

    const partOf = await client.query(
      `SELECT c."statement" FROM "claims" c WHERE c."predicate" = 'PART_OF' AND c."user_id" = $1`,
      [userId],
    );
    // Only the existing day node gets an edge (the other 6 days have no node).
    expect(partOf.rowCount).toBe(1);
    expect(partOf.rows[0].statement).toBe("2026-01-06 is part of 2026-W02");

    // Re-run: fingerprint-skips, and does not duplicate the claim.
    expect(await summarizePeriod(params)).toBe("skipped-unchanged");
    const partOfAgain = await client.query(
      `SELECT count(*)::int AS n FROM "claims" WHERE "predicate" = 'PART_OF' AND "user_id" = $1`,
      [userId],
    );
    expect(partOfAgain.rows[0].n).toBe(1);
  });

  it("skips a week whose days have no summaries", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    expect(
      await summarizePeriod({
        db,
        userId,
        periodKey: "2026-W30",
        client: openai,
        rollupSourceId,
      }),
    ).toBe("skipped-empty");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- src/lib/rollup/summarize-period.test.ts --run`
Expected: FAIL — cannot resolve `./summarize-period`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/rollup/summarize-period.ts`:

```typescript
/**
 * Summarize a single rollup period: deterministic input → fingerprint
 * gate → one structured LLM completion → summary written to the period
 * node's `nodeMetadata.description` (+ `additionalData.rollup` marker) →
 * embedding refresh → idempotent PART_OF containment claims.
 */
import { collectPeriodInput, fingerprintOf, readRollupMeta } from "./collect";
import { periodLevelOf, type PeriodLevel } from "./period";
import { and, eq, inArray } from "drizzle-orm";
import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { claims, nodeEmbeddings, nodeMetadata } from "~/db/schema";
import { parseStructuredCompletion } from "~/lib/ai";
import { generateEmbeddings } from "~/lib/embeddings";
import { ensurePeriodNode } from "~/lib/temporal";
import type { TypeId } from "~/types/typeid";
import { MODEL_MAX_OUTPUT_TOKENS, modelForTask } from "~/utils/models";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

const LEVEL_PROMPT_INTRO: Record<PeriodLevel, string> = {
  day: `You are summarizing one day of a person's life from entries in their personal memory graph (conversations, documents, events).

Write a concise narrative summary of the day. Be concrete and specific: name the people, projects, places, decisions, and outcomes involved. Use past tense. Skip meta-commentary and filler; if entries are sparse, keep the summary proportionally short.`,
  week: `You are summarizing one week of a person's life from their daily summaries.

Write a narrative summary of the week's arc: key events, recurring themes, progress on projects, notable people, decisions, and changes. Synthesize across days rather than listing day-by-day. Use past tense; be concrete and specific. Days marked "(no summarized activity)" simply have no recorded data — don't speculate about them.`,
  month: `You are summarizing one month of a person's life from weekly summaries. Boundary weeks may only partially overlap the month — weigh only the overlapping days.

Write a narrative summary of the month: dominant themes, milestones, project progress, important relationships, and notable shifts. Use past tense; be concrete and specific.`,
  year: `You are summarizing one year of a person's life from monthly summaries.

Write a narrative summary of the year: major arcs, milestones, turning points, recurring themes, and how things changed from beginning to end. Use past tense; be concrete and specific.`,
};

const periodSummarySchema = z.object({
  summary: z
    .string()
    .describe(
      "Narrative summary of the period; concrete, specific, past tense",
    ),
});

export type SummarizePeriodOutcome =
  | "summarized"
  | "skipped-unchanged"
  | "skipped-empty";

export interface SummarizePeriodParams {
  db: DrizzleDB;
  userId: string;
  periodKey: string;
  /** Completion client created once per sweep (task: temporal_summary). */
  client: OpenAI;
  /** Per-user synthetic rollup source backing PART_OF claims. */
  rollupSourceId: TypeId<"source">;
}

export async function summarizePeriod({
  db,
  userId,
  periodKey,
  client,
  rollupSourceId,
}: SummarizePeriodParams): Promise<SummarizePeriodOutcome> {
  const level = periodLevelOf(periodKey);

  const collected = await collectPeriodInput(db, userId, periodKey, level);
  if (!collected) return "skipped-empty";

  const nodeId = await ensurePeriodNode(db, userId, periodKey);

  // Containment edges first (and on every run) so a previously interrupted
  // run is repaired even when the summary itself fingerprint-skips.
  await ensurePartOfClaims(
    db,
    userId,
    collected.childNodeIds,
    nodeId,
    periodKey,
    rollupSourceId,
  );

  const fingerprint = fingerprintOf(collected.inputText);
  const [meta] = await db
    .select({
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, nodeId))
    .limit(1);
  if (!meta) {
    throw new Error(`Period node ${periodKey} (${nodeId}) has no metadata row`);
  }
  if (readRollupMeta(meta.additionalData)?.fingerprint === fingerprint) {
    return "skipped-unchanged";
  }

  const completion = await parseStructuredCompletion(
    client,
    {
      messages: [
        {
          role: "user",
          content: `${LEVEL_PROMPT_INTRO[level]}\n\n${collected.inputText}`,
        },
      ],
      model: modelForTask("temporal_summary"),
      max_tokens: MODEL_MAX_OUTPUT_TOKENS,
      response_format: zodResponseFormat(periodSummarySchema, "period_summary"),
    },
    { task: "temporal_summary", userId },
  );
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error(`Failed to parse period summary for ${periodKey}`);
  }

  const existingData =
    meta.additionalData &&
    typeof meta.additionalData === "object" &&
    !Array.isArray(meta.additionalData)
      ? (meta.additionalData as Record<string, unknown>)
      : {};
  await db
    .update(nodeMetadata)
    .set({
      description: parsed.summary,
      additionalData: {
        ...existingData,
        rollup: { fingerprint, summarizedAt: new Date().toISOString() },
      },
    })
    .where(eq(nodeMetadata.nodeId, nodeId));

  if (!shouldSkipEmbeddingPersistence()) {
    const embText = `${periodKey}: ${parsed.summary}`;
    const embResponse = await generateEmbeddings({
      model: "jina-embeddings-v3",
      task: "retrieval.passage",
      input: [embText],
      truncate: true,
    });
    const embedding = embResponse.data[0]?.embedding;
    if (embedding) {
      await db.delete(nodeEmbeddings).where(eq(nodeEmbeddings.nodeId, nodeId));
      await db.insert(nodeEmbeddings).values({
        nodeId,
        embedding,
        modelName: "jina-embeddings-v3",
      });
    }
  }

  return "summarized";
}

/** Child PART_OF parent claims for every existing child node, idempotent. */
async function ensurePartOfClaims(
  db: DrizzleDB,
  userId: string,
  childNodeIds: TypeId<"node">[],
  parentNodeId: TypeId<"node">,
  parentKey: string,
  rollupSourceId: TypeId<"source">,
): Promise<void> {
  if (childNodeIds.length === 0) return;

  const existing = await db
    .select({ subjectNodeId: claims.subjectNodeId })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.objectNodeId, parentNodeId),
        eq(claims.predicate, "PART_OF"),
        eq(claims.status, "active"),
        inArray(claims.subjectNodeId, childNodeIds),
      ),
    );
  const linked = new Set(existing.map((c) => c.subjectNodeId));
  const missing = childNodeIds.filter((id) => !linked.has(id));
  if (missing.length === 0) return;

  const labels = await db
    .select({ nodeId: nodeMetadata.nodeId, label: nodeMetadata.label })
    .from(nodeMetadata)
    .where(inArray(nodeMetadata.nodeId, missing));
  const labelOf = new Map(labels.map((l) => [l.nodeId, l.label]));

  await db.insert(claims).values(
    missing.map((childNodeId) => ({
      userId,
      predicate: "PART_OF" as const,
      subjectNodeId: childNodeId,
      objectNodeId: parentNodeId,
      statement: `${labelOf.get(childNodeId) ?? childNodeId} is part of ${parentKey}`,
      sourceId: rollupSourceId,
      scope: "personal" as const,
      assertedByKind: "system" as const,
      statedAt: new Date(),
      status: "active" as const,
    })),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- src/lib/rollup/summarize-period.test.ts --run`
Expected: PASS (4 tests). Then `pnpm run build:check` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rollup/summarize-period.ts src/lib/rollup/summarize-period.test.ts
git commit -m "✨ feat(rollup): per-period summarization with fingerprint gate and PART_OF claims"
```

### Task 7: The sweep job (`runRollup`)

**Files:**

- Create: `src/lib/jobs/rollup.ts`
- Create: `src/lib/schemas/rollup.ts`
- Test: `src/lib/jobs/rollup.test.ts`

The sweep: discover stale days from `OCCURRED_ON` claims past the watermark → expand to ancestors ∪ `pendingPeriods` → apply `startDate` floor (exclude + purge) and completeness filter (defer) → process bottom-up within the LLM-call budget → commit watermark + pending. The watermark ALWAYS advances to the max claim `createdAt` seen; deferred/failed work is carried only by `pendingPeriods`.

- [ ] **Step 1: Write the request/response schemas**

Create `src/lib/schemas/rollup.ts`:

```typescript
import { z } from "zod";

export const rollupRequestSchema = z.object({
  userId: z.string().min(1),
  /** Hard cap on LLM calls this sweep; leftovers resume on the next call. */
  maxLlmCalls: z.number().int().positive().max(500).default(50),
  /**
   * History floor (yyyy-MM-dd). Periods ending before this are excluded
   * outright — never summarized, purged from pending. Prevents a first
   * sweep over a backlogged account from paying for ancient history.
   */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be yyyy-MM-dd")
    .optional(),
});

export type RollupRequest = z.infer<typeof rollupRequestSchema>;

export const rollupResponseSchema = z.object({
  message: z.string(),
  enqueued: z.boolean(),
});

export type RollupResponse = z.infer<typeof rollupResponseSchema>;
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/jobs/rollup.test.ts`. It reuses the table SQL + LLM stub exported from `src/lib/rollup/summarize-period.test.ts` (`ROLLUP_TEST_TABLES_SQL`, `stubLlm`):

```typescript
import { runRollup } from "./rollup";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  ROLLUP_TEST_TABLES_SQL,
  stubLlm,
} from "~/lib/rollup/summarize-period.test";
import { ensurePeriodNode } from "~/lib/temporal";
import { newTypeId } from "~/types/typeid";
import {
  resetTestOverrides,
  setExtractionClientOverride,
  setSkipEmbeddingPersistence,
} from "~/utils/test-overrides";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

const TODAY = "2026-06-15";

describeIfServer("runRollup", () => {
  const dbName = `memory_rollup_job_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    setSkipEmbeddingPersistence(true);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(ROLLUP_TEST_TABLES_SQL);
    db = drizzle(client, { schema, casing: "snake_case" });
  });

  afterEach(() => {
    resetTestOverrides();
    setSkipEmbeddingPersistence(true);
  });

  afterAll(async () => {
    resetTestOverrides();
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  async function seedUser(userId: string): Promise<void> {
    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  }

  /** A content node OCCURRED_ON the given day (creates the day node too). */
  async function seedContent(
    userId: string,
    dayKey: string,
    label: string,
  ): Promise<void> {
    const dayNodeId = await ensurePeriodNode(db, userId, dayKey);
    const contentNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
       VALUES ($1, $2, 'conversation', $3)`,
      [sourceId, userId, `conv-${label}`],
    );
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Conversation')`,
      [contentNodeId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "description")
       VALUES ($1, $2, $3, 'Some details.')`,
      [newTypeId("node_metadata"), contentNodeId, label],
    );
    await client.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_node_id", "predicate",
        "statement", "source_id", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, $4, 'OCCURRED_ON', 'occurred', $5, 'system', now())`,
      [newTypeId("claim"), userId, contentNodeId, dayNodeId, sourceId],
    );
  }

  async function pendingOf(userId: string): Promise<string[]> {
    const rows = await client.query(
      `SELECT "pending_periods" FROM "rollup_state" WHERE "user_id" = $1`,
      [userId],
    );
    return rows.rows[0]?.pending_periods ?? [];
  }

  async function summaryOf(
    userId: string,
    label: string,
  ): Promise<string | null> {
    const rows = await client.query(
      `SELECT m."description" FROM "node_metadata" m
       JOIN "nodes" n ON n."id" = m."node_id"
       WHERE n."user_id" = $1 AND m."label" = $2 AND m."additional_data" -> 'rollup' IS NOT NULL`,
      [userId, label],
    );
    return rows.rows[0]?.description ?? null;
  }

  it("builds the full hierarchy bottom-up and defers the open year", async () => {
    const userId = "u_full";
    await seedUser(userId);
    // W02 2026 = Jan 5–11; W03 = Jan 12–18.
    await seedContent(userId, "2026-01-05", "Kickoff");
    await seedContent(userId, "2026-01-07", "Design review");
    await seedContent(userId, "2026-01-13", "Retro");

    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });

    // 3 days + 2 weeks + 1 month = 6; year 2026 is still open.
    expect(result).toMatchObject({ summarized: 6, failed: 0 });
    expect(calls).toHaveLength(6);
    expect(await summaryOf(userId, "2026-01-05")).toMatch(/^LLM summary/);
    expect(await summaryOf(userId, "2026-W02")).toMatch(/^LLM summary/);
    expect(await summaryOf(userId, "2026-W03")).toMatch(/^LLM summary/);
    expect(await summaryOf(userId, "2026-01")).toMatch(/^LLM summary/);
    expect(await pendingOf(userId)).toEqual(["2026"]);

    // PART_OF: 3 day→week + 2 week→month (only existing week nodes link).
    const partOf = await client.query(
      `SELECT count(*)::int AS n FROM "claims" WHERE "user_id" = $1 AND "predicate" = 'PART_OF'`,
      [userId],
    );
    expect(partOf.rows[0].n).toBe(5);

    const state = await client.query(
      `SELECT "watermark" FROM "rollup_state" WHERE "user_id" = $1`,
      [userId],
    );
    expect(state.rows[0].watermark).not.toBeNull();
  });

  it("costs zero LLM calls when nothing changed", async () => {
    const userId = "u_full";
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    expect(result.summarized).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await pendingOf(userId)).toEqual(["2026"]);
  });

  it("summarizes a completed year", async () => {
    const userId = "u_year";
    await seedUser(userId);
    await seedContent(userId, "2025-03-10", "Spring planning");

    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    // day + week (2025-W11) + month (2025-03) + year (2025) = 4.
    expect(result.summarized).toBe(4);
    expect(calls).toHaveLength(4);
    expect(await summaryOf(userId, "2025")).toMatch(/^LLM summary/);
    expect(await pendingOf(userId)).toEqual([]);
  });

  it("re-summarizes the cascade when old content is backfilled", async () => {
    const userId = "u_full";
    // New claim (createdAt = now > watermark) pointing at the old day.
    await seedContent(userId, "2026-01-07", "Backfilled memo");

    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    // Day 2026-01-07 + week W02 + month 2026-01 re-run; W03 untouched.
    expect(result.summarized).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("defers over-budget work to pending and resumes on the next sweep", async () => {
    const userId = "u_budget";
    await seedUser(userId);
    await seedContent(userId, "2026-01-05", "A");
    await seedContent(userId, "2026-01-06", "B");
    await seedContent(userId, "2026-01-07", "C");
    await seedContent(userId, "2026-01-08", "D");
    await seedContent(userId, "2026-01-12", "E");

    const { client: llm1, calls: calls1 } = stubLlm();
    setExtractionClientOverride(llm1);
    const first = await runRollup({
      db,
      userId,
      maxLlmCalls: 3,
      todayKey: TODAY,
    });
    expect(first.summarized).toBe(3);
    expect(calls1).toHaveLength(3);
    const pendingAfterFirst = await pendingOf(userId);
    expect(pendingAfterFirst).toContain("2026-01-08");
    expect(pendingAfterFirst).toContain("2026-W02");

    const { client: llm2, calls: calls2 } = stubLlm();
    setExtractionClientOverride(llm2);
    const second = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    // Remaining: days 01-08, 01-12 + weeks W02, W03 + month 2026-01 = 5.
    expect(second.summarized).toBe(5);
    expect(calls2).toHaveLength(5);
    expect(await pendingOf(userId)).toEqual(["2026"]);
  });

  it("startDate excludes pre-floor periods and purges them from pending", async () => {
    const userId = "u_floor";
    await seedUser(userId);
    await seedContent(userId, "2025-12-15", "Old era");
    await seedContent(userId, "2026-01-06", "New era");

    // First sweep with a zero budget: everything ready lands in pending.
    const { client: llm0 } = stubLlm();
    setExtractionClientOverride(llm0);
    const zero = await runRollup({
      db,
      userId,
      maxLlmCalls: 0,
      todayKey: TODAY,
    });
    expect(zero.summarized).toBe(0);
    expect(await pendingOf(userId)).toContain("2025-12-15");

    // Second sweep with the floor: 2025 periods are gone for good.
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);
    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      startDate: "2026-01-01",
      todayKey: TODAY,
    });
    // 2026-01-06 + W02 + 2026-01 = 3 (W02 ends 2026-01-11 ≥ floor).
    expect(result.summarized).toBe(3);
    expect(calls).toHaveLength(3);
    expect(await summaryOf(userId, "2025-12-15")).toBeNull();
    expect(await summaryOf(userId, "2025-12")).toBeNull();
    expect(await pendingOf(userId)).toEqual(["2026"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm run test -- src/lib/jobs/rollup.test.ts --run`
Expected: FAIL — cannot resolve `./rollup`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/jobs/rollup.ts`:

```typescript
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
import { and, eq, gt, type SQL } from "drizzle-orm";
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
  const touched = await db
    .select({
      dayLabel: nodeMetadata.label,
      claimCreatedAt: claims.createdAt,
    })
    .from(claims)
    .innerJoin(nodes, eq(nodes.id, claims.objectNodeId))
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(...conditions));

  let watermark = state?.watermark ?? null;
  const touchedDayKeys = new Set<string>();
  for (const row of touched) {
    if (!watermark || row.claimCreatedAt > watermark) {
      watermark = row.claimCreatedAt;
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run test -- src/lib/jobs/rollup.test.ts --run`
Expected: PASS (6 tests). Then `pnpm run build:check` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/jobs/rollup.ts src/lib/jobs/rollup.test.ts src/lib/schemas/rollup.ts
git commit -m "✨ feat(rollup): catch-up sweep job with watermark, budget, and startDate floor"
```

### Task 8: Queue registration + `POST /rollup` route

**Files:**

- Modify: `src/lib/queues.ts`
- Create: `src/routes/rollup.post.ts`
- Test: `src/rollup-route.test.ts` (route tests live at `src/` top level, e.g. `src/query-recent-changes-route.test.ts`)

- [ ] **Step 1: Register the job in `src/lib/queues.ts`**

Add to the imports at the top:

```typescript
import { rollupRequestSchema } from "./schemas/rollup";
```

Add directly below `SUMMARIZE_JOB_OPTIONS`:

```typescript
/**
 * Retry profile for the temporal-rollup sweep. The sweep is idempotent
 * (watermark + per-period fingerprints), so a BullMQ retry after a partial
 * failure only re-pays for periods that were never written. `removeOnFail`
 * keeps a short failure history without blocking the deterministic
 * `rollup:<userId>` jobId from being re-enqueued later (the route removes
 * finished/failed jobs before re-adding).
 */
export const ROLLUP_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: true,
  removeOnFail: 100,
} as const;
```

Add a worker branch directly after the `"summarize"` branch (before `} else if (job.name === "dream")`):

```typescript
      } else if (job.name === "rollup") {
        const { userId, maxLlmCalls, startDate } = rollupRequestSchema.parse(
          job.data,
        );
        console.log(`Starting rollup job for user ${userId}`);
        const { runRollup } = await import("./jobs/rollup");
        const result = await runRollup({
          db,
          userId,
          maxLlmCalls,
          ...(startDate !== undefined ? { startDate } : {}),
        });
        console.log(
          `Rollup for user ${userId}: ${result.summarized} summarized, ${result.skippedUnchanged} unchanged, ${result.skippedEmpty} empty, ${result.failed} failed, ${result.deferred} deferred.`,
        );
```

- [ ] **Step 2: Write the failing route test**

Create `src/rollup-route.test.ts`:

```typescript
import handler from "./routes/rollup.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";

const queueMocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  add: vi.fn(),
}));

vi.mock("~/lib/queues", () => ({
  batchQueue: { getJob: queueMocks.getJob, add: queueMocks.add },
  ROLLUP_JOB_OPTIONS: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
    removeOnComplete: true,
    removeOnFail: 100,
  },
}));

describe("POST /rollup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("applies defaults and enqueues with a deterministic jobId", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "user_r" }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});

    const response = await handler({} as H3Event);

    expect(queueMocks.add).toHaveBeenCalledWith(
      "rollup",
      { userId: "user_r", maxLlmCalls: 50 },
      expect.objectContaining({ jobId: "rollup:user_r", attempts: 3 }),
    );
    expect(response).toMatchObject({ enqueued: true });
  });

  it("passes startDate and maxLlmCalls through", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_r",
      maxLlmCalls: 10,
      startDate: "2026-01-01",
    }));
    queueMocks.getJob.mockResolvedValue(undefined);
    queueMocks.add.mockResolvedValue({});

    await handler({} as H3Event);

    expect(queueMocks.add).toHaveBeenCalledWith(
      "rollup",
      { userId: "user_r", maxLlmCalls: 10, startDate: "2026-01-01" },
      expect.objectContaining({ jobId: "rollup:user_r" }),
    );
  });

  it("does not double-enqueue while a sweep is queued or running", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "user_r" }));
    queueMocks.getJob.mockResolvedValue({
      getState: async () => "waiting",
      remove: vi.fn(),
    });

    const response = await handler({} as H3Event);

    expect(queueMocks.add).not.toHaveBeenCalled();
    expect(response).toMatchObject({ enqueued: false });
  });

  it("removes a finished job with the same id, then re-enqueues", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "user_r" }));
    const remove = vi.fn();
    queueMocks.getJob.mockResolvedValue({
      getState: async () => "failed",
      remove,
    });
    queueMocks.add.mockResolvedValue({});

    const response = await handler({} as H3Event);

    expect(remove).toHaveBeenCalled();
    expect(queueMocks.add).toHaveBeenCalled();
    expect(response).toMatchObject({ enqueued: true });
  });

  it("rejects a malformed startDate before enqueueing", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_r",
      startDate: "Jan 1",
    }));

    await expect(handler({} as H3Event)).rejects.toThrow();
    expect(queueMocks.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm run test -- src/rollup-route.test.ts --run`
Expected: FAIL — cannot resolve `./routes/rollup.post`.

- [ ] **Step 4: Write the route**

Create `src/routes/rollup.post.ts`:

```typescript
/**
 * `POST /rollup` — enqueue a temporal-rollup catch-up sweep for a user.
 *
 * Fire-and-forget: the sweep runs as a BullMQ job. A deterministic
 * `rollup:<userId>` jobId collapses concurrent triggers for the same user
 * into one queued sweep. Cost control belongs to the caller: `maxLlmCalls`
 * caps this sweep, `startDate` floors how far back history is summarized.
 */
// `readBody` is deliberately NOT imported: Nitro auto-imports it globally
// (same as src/routes/digest.post.ts), which is what lets the route test
// stub it via vi.stubGlobal.
import { defineEventHandler } from "h3";
import { batchQueue, ROLLUP_JOB_OPTIONS } from "~/lib/queues";
import {
  rollupRequestSchema,
  rollupResponseSchema,
} from "~/lib/schemas/rollup";

export default defineEventHandler(async (event) => {
  const params = rollupRequestSchema.parse(await readBody(event));
  const jobId = `rollup:${params.userId}`;

  const existing = await batchQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      return rollupResponseSchema.parse({
        message: `Rollup already queued for user ${params.userId}.`,
        enqueued: false,
      });
    }
    // Completed/failed leftovers block re-use of the deterministic jobId.
    await existing.remove();
  }

  await batchQueue.add("rollup", params, { ...ROLLUP_JOB_OPTIONS, jobId });
  console.log(`Enqueued 'rollup' job for user: ${params.userId}`);

  return rollupResponseSchema.parse({
    message: `Rollup job for user ${params.userId} enqueued successfully.`,
    enqueued: true,
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm run test -- src/rollup-route.test.ts --run`
Expected: PASS (5 tests). Then `pnpm run build:check` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queues.ts src/routes/rollup.post.ts src/rollup-route.test.ts
git commit -m "✨ feat(rollup): POST /rollup route and BullMQ job registration"
```

---

### Task 9: SDK method

**Files:**

- Modify: `src/sdk/memory-client.ts`
- Modify: `src/sdk/index.ts`

- [ ] **Step 1: Add the `rollup` method to `MemoryClient`**

In `src/sdk/memory-client.ts`, add to the schema imports (match the existing `.js`-suffixed import style, alphabetical placement among the other `../lib/schemas/*` imports):

```typescript
import {
  rollupResponseSchema,
  type RollupRequest,
  type RollupResponse,
} from "../lib/schemas/rollup.js";
```

Add the method directly after the existing `summarize` method:

```typescript
  /**
   * Trigger a temporal-rollup catch-up sweep (day/week/month/year summary
   * nodes). Fire-and-forget; `maxLlmCalls` caps the sweep's LLM spend and
   * `startDate` floors how far back history is summarized.
   */
  async rollup(payload: RollupRequest): Promise<RollupResponse> {
    return this._fetch("POST", "/rollup", rollupResponseSchema, payload);
  }
```

- [ ] **Step 2: Export the schemas from the SDK**

In `src/sdk/index.ts`, add (next to the `summarize.js` export line):

```typescript
export * from "../lib/schemas/rollup.js";
```

- [ ] **Step 3: Verify the SDK builds**

Run: `pnpm run build:check && pnpm run build-sdk`
Expected: both clean (tsc, structured-output check, SDK build + verify script).

- [ ] **Step 4: Commit**

```bash
git add src/sdk/memory-client.ts src/sdk/index.ts
git commit -m "✨ feat(sdk): rollup() trigger for temporal summarization"
```

---

### Task 10: Final validation

- [ ] **Step 1: Full verification gates**

Run, in order, expecting every one clean:

```bash
pnpm run build:check
pnpm run lint
pnpm run format
pnpm run test -- --run
```

If `pnpm run format` fails, run `pnpm run format:fix` and re-check. If any test outside this feature fails, STOP and report BLOCKED — do not "fix" unrelated tests.

- [ ] **Step 2: Mark the spec as implemented**

In `docs/superpowers/specs/2026-06-12-temporal-rollup-design.md`, change the Status line to:

```markdown
**Status:** Implemented — plan at docs/superpowers/plans/2026-06-12-temporal-rollup.md
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-12-temporal-rollup-design.md docs/superpowers/plans/2026-06-12-temporal-rollup.md
git commit -m "📚 docs(rollup): mark temporal rollup spec implemented"
```

---

## Notes for the executor

- **Test DB**: integration suites self-skip when Postgres on :5431 is unreachable — a "pass" with everything skipped is NOT a pass. Start services with `docker compose up -d` first and confirm the suites actually ran.
- **No internal scheduling**: do not add cron/intervals anywhere; the only trigger is `POST /rollup`.
- **Don't touch** `pendingPeriods` semantics casually: the watermark always advances; pending is the only carrier of deferred work. Both tests in Task 7 encode this.
- **`runRollup` accepts `maxLlmCalls: 0`** at the function level (used by tests to force-defer); the HTTP schema floor is 1 — that difference is intentional.
- The `summarize-period.test.ts` file deliberately exports `ROLLUP_TEST_TABLES_SQL` and `stubLlm` for reuse by `rollup.test.ts`.
