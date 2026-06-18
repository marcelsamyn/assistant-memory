# Timeline `since`/`until` Window Bounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `queryTimeline`'s counterintuitive `startDate`/`endDate` bounds with conventional, optional `since`/`until` bounds, and make `includePeriods` return the rollup periods covering the in-range days (including past periods).

**Architecture:** `queryTimeline` is a REST handler (`src/lib/query/timeline.ts`) behind a thin route, exposed to consumers through the published `@marcelsamyn/memory` SDK. The request shape lives in a Zod schema; the SDK client forwards it unchanged, so renaming the schema fields updates the SDK type surface automatically. Period loading moves from "enumerate every calendar day in a window" to "derive period keys from the day nodes actually in range."

**Tech Stack:** TypeScript (NodeNext ESM), Zod v4, Drizzle ORM (Postgres), Vitest, pnpm. SDK built via `pnpm run build-sdk` (tsc + tsc-alias + `verify-sdk-build.mjs`).

## Global Constraints

- This is a **breaking SDK change** → next release is a **major version bump** (`1.29.0` → `2.0.0`), cut with `pnpm version major` (creates the commit + `v2.0.0` tag).
- `queryTimeline` is consumed only by Petals; no n8n node, no other repo. No backward-compat shim — rename cleanly.
- Do **not** touch the rollup job's unrelated `startDate` parameter (`src/lib/jobs/rollup.ts`, `src/lib/queues.ts`, `src/lib/schemas/rollup.ts`, `src/routes/rollup.post.ts`, and the `memory-client.ts:685` doc comment). Only `query-timeline` bounds change.
- `since` = earliest day inclusive; `until` = latest day inclusive; both optional; omitted = unbounded on that side. No defensive min/max swap.
- Day-node label format is `YYYY-MM-DD`; rollup-period labels are `2026` / `2026-06` / `2026-W24`.
- All work on branch `feat/timeline-since-until` in `/Users/marcel/code/assistant-memory`.
- Verification commands (run from repo root): `pnpm run build:check`, `pnpm run lint`, `pnpm run format`, `pnpm run build-sdk`, `pnpm test --run`. DB-backed tests need Postgres on `localhost:5431` (they `describe.skip` if unreachable).

## File Structure

- `src/lib/schemas/query-timeline.ts` — request schema field rename (Task 1).
- `src/lib/schemas/query-timeline.test.ts` — schema test field rename (Task 1).
- `src/lib/query/timeline-periods.ts` — rewrite `loadTimelinePeriods`; delete `periodKeysForWindow` (Task 2).
- `src/lib/query/timeline-periods.test.ts` — drop `periodKeysForWindow` block; add open-bound assertions (Task 2).
- `src/lib/query/timeline.ts` — handler: `since`/`until` + conditional bounds (Task 3).
- `src/lib/query/timeline.test.ts` — handler test field rename + open-`until` regression (Task 3).
- `package.json` — `prepublishOnly` hook (Task 4).
- `CHANGELOG.md`, `docs/sdk-consumer-migration.md` — release notes (Task 5).

---

### Task 1: Rename request schema `startDate`/`endDate` → `since`/`until`

**Files:**

- Modify: `src/lib/schemas/query-timeline.ts:7-22` (request schema), and `QueryTimelineRequest` type (already inferred — no manual change).
- Test: `src/lib/schemas/query-timeline.test.ts:7-82`

**Interfaces:**

- Produces: `queryTimelineRequestSchema` with optional `since?: string` and `until?: string` (both `YYYY-MM-DD`), unchanged `userId`, `limit` (default 30, 1–100), `offset` (default 0, ≥0), `nodeTypes?`, `includePeriods?`. `QueryTimelineRequest = z.infer<...>`. Consumed by Tasks 2 and 3 and by `src/sdk/memory-client.ts` (`queryTimeline(payload: QueryTimelineRequest)`).

- [ ] **Step 1: Update the schema test to the new field names**

In `src/lib/schemas/query-timeline.test.ts`, replace the `startDate`/`endDate` references:

Lines 13-14 become:

```ts
expect(parsed.since).toBeUndefined();
expect(parsed.until).toBeUndefined();
```

Lines 21-22 and 27-28 (the "full request" case) become:

```ts
      since: "2024-10-15",
      until: "2025-01-15",
```

```ts
expect(parsed.since).toBe("2024-10-15");
expect(parsed.until).toBe("2025-01-15");
```

Lines 34-40 (invalid date) become:

```ts
it("rejects invalid date format", () => {
  expect(() =>
    queryTimelineRequestSchema.parse({
      userId: "user_123",
      since: "01-15-2025",
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `pnpm test --run src/lib/schemas/query-timeline.test.ts`
Expected: FAIL — `since`/`until` are not yet in the schema (parsed values undefined / unknown key stripped, assertions fail).

- [ ] **Step 3: Rename the fields in the schema**

In `src/lib/schemas/query-timeline.ts`, replace lines 9-16 (`startDate`/`endDate` blocks) with:

```ts
    since: z
        .string()
        .regex(dateRegex, "since must be in YYYY-MM-DD format")
        .optional(),
    until: z
        .string()
        .regex(dateRegex, "until must be in YYYY-MM-DD format")
        .optional(),
```

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `pnpm test --run src/lib/schemas/query-timeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Confirm the SDK type surface still compiles**

Run: `pnpm run build:check`
Expected: PASS (the SDK client `queryTimeline(payload: QueryTimelineRequest)` picks up the renamed fields; `src/lib/query/timeline.ts` will still reference `params.startDate`/`endDate` and FAIL here — that's expected and fixed in Task 3, so if build:check fails _only_ in `src/lib/query/timeline.ts`, proceed; if it fails elsewhere, stop and investigate).

- [ ] **Step 6: Commit**

```bash
git add src/lib/schemas/query-timeline.ts src/lib/schemas/query-timeline.test.ts
git commit -m "♻️ refactor(timeline): rename queryTimeline bounds to since/until"
```

---

### Task 2: Derive periods from in-range day nodes (`loadTimelinePeriods`)

**Files:**

- Modify: `src/lib/query/timeline-periods.ts` (full rewrite — delete `periodKeysForWindow`, new `loadTimelinePeriods` signature/body)
- Test: `src/lib/query/timeline-periods.test.ts`

**Interfaces:**

- Consumes: `monthKeyForDay(dayKey: string): string`, `weekKeyForDay(dayKey: string): string`, `yearKeyForMonth(monthKey: string): string`, `periodLevelOf(key: string): "day"|"week"|"month"|"year"` from `../rollup/period`; `readRollupMeta` from `../rollup/collect`; `QueryTimelinePeriod` from `../schemas/query-timeline`.
- Produces: `loadTimelinePeriods(db, userId, since?, until?): Promise<QueryTimelinePeriod[]>` — returns rollup periods (`{ key, granularity, summary, temporalNodeId }`) for the week/month/year buckets that contain at least one day node in `[since, until]`, ordered by `key` ascending. Consumed by Task 3.

- [ ] **Step 1: Update the periods test (remove window helper, add open-bound assertions)**

In `src/lib/query/timeline-periods.test.ts`:

(a) Change the import on line 1 to drop `periodKeysForWindow`:

```ts
import { loadTimelinePeriods } from "./timeline-periods";
```

(b) Delete the entire `describe("periodKeysForWindow", () => { ... })` block (lines 8-29).

(c) Inside the `loadTimelinePeriods` test, after the existing `expect(... not.toContain("2026-05"))` assertion (around line 198) and before the `"nobody"` assertion, add:

```ts
// Past feed shape: only `until` set, `since` open. Periods are still
// derived from the in-range day node (2026-06-10 → W24), and a
// summarized rollup with no day node in range (2026-05) stays excluded.
const openSince = await loadTimelinePeriods(
  database,
  userId,
  undefined,
  "2026-06-30",
);
expect(openSince.map((p) => p.key)).toEqual(["2026", "2026-06", "2026-W24"]);
expect(openSince.map((p) => p.key)).not.toContain("2026-05");

// Fully open window behaves the same here (all day nodes are in June).
const openBoth = await loadTimelinePeriods(database, userId);
expect(openBoth.map((p) => p.key)).toEqual(["2026", "2026-06", "2026-W24"]);
```

- [ ] **Step 2: Run the periods test to verify it fails**

Run: `pnpm test --run src/lib/query/timeline-periods.test.ts`
Expected: FAIL — `periodKeysForWindow` no longer imported breaks the build, and/or `loadTimelinePeriods` doesn't yet accept optional bounds. (If Postgres is unreachable the `loadTimelinePeriods` block is skipped; the import/compile failure still makes the run fail.)

- [ ] **Step 3: Rewrite `timeline-periods.ts`**

Replace the **entire** contents of `src/lib/query/timeline-periods.ts` with:

```ts
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
```

- [ ] **Step 4: Run the periods test to verify it passes**

Run: `pnpm test --run src/lib/query/timeline-periods.test.ts`
Expected: PASS (or SKIP for the DB block if Postgres is unreachable — in that case run with Postgres up before considering the task done; the file must at least compile and the run must be green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/query/timeline-periods.ts src/lib/query/timeline-periods.test.ts
git commit -m "♻️ refactor(timeline): derive rollup periods from in-range day nodes"
```

---

### Task 3: Handler uses `since`/`until` with conditional bounds

**Files:**

- Modify: `src/lib/query/timeline.ts:24-48` (param read, window logic, day WHERE) and the `date-fns` import line.
- Test: `src/lib/query/timeline.test.ts` (field renames + open-`until` regression)

**Interfaces:**

- Consumes: `loadTimelinePeriods(db, userId, since?, until?)` (Task 2); `QueryTimelineRequest.since/until` (Task 1).
- Produces: `queryTimeline(params): Promise<QueryTimelineResponse>` — unchanged response shape; day feed filtered by optional `since`/`until`, periods loaded for the same bounds.

- [ ] **Step 1: Update the handler test (rename fields + add open-`until` regression)**

In `src/lib/query/timeline.test.ts`:

(a) The `base` call (lines 232-236) — swap to intuitive bounds:

```ts
          queryTimelineRequestSchema.parse({
            userId,
            since: "2026-06-01",
            until: "2026-06-30",
          }),
```

(b) The `withPeriods` call (lines 251-256):

```ts
          queryTimelineRequestSchema.parse({
            userId,
            since: "2026-06-01",
            until: "2026-06-30",
            includePeriods: true,
          }),
```

(c) The `spanning` call (lines 281-285):

```ts
          queryTimelineRequestSchema.parse({
            userId,
            since: "2026-06-01",
            until: "2026-07-31",
          }),
```

(d) After the `withPeriods` assertions (after line 273, before the `spanning` block's comment on line 275), add the bug regression — the Petals past-feed shape (only `until`, `since` open) must return the past periods:

```ts
// Regression: the Petals past feed sends only `until` (open `since`).
// The week/month/year periods for in-range days must come back — not just
// the current period — which the old `endDate`-collapses-the-window bug
// dropped.
const pastFeed = queryTimelineResponseSchema.parse(
  await queryTimeline(
    queryTimelineRequestSchema.parse({
      userId,
      until: "2026-12-31",
      includePeriods: true,
    }),
  ),
);
expect(pastFeed.periods.map((p) => p.key)).toEqual([
  "2026",
  "2026-06",
  "2026-W24",
]);
```

- [ ] **Step 2: Run the handler test to verify it fails**

Run: `pnpm test --run src/lib/query/timeline.test.ts`
Expected: FAIL — schema no longer has `startDate`/`endDate`, so the handler (still reading `params.startDate`) and/or the renamed test calls don't line up. (DB block skips if Postgres down; compile failure still fails the run.)

- [ ] **Step 3: Update the handler**

In `src/lib/query/timeline.ts`:

(a) Replace the destructure + window block (lines 24-33) with:

```ts
const {
  userId,
  since,
  until,
  limit = 30,
  offset = 0,
  nodeTypes,
  includePeriods,
} = params;

const db = await useDatabase();
```

(This deletes `today`, `ninetyDaysAgo`, `startDate`, `endDate`, `rangeMin`, `rangeMax`. Note `const db = await useDatabase();` moves up here; delete the later duplicate `const db = await useDatabase();` that was on line 35.)

(b) Replace the `periods` assignment (was lines 37-39) so it sits right after `db`:

```ts
const periods = includePeriods
  ? await loadTimelinePeriods(db, userId, since, until)
  : [];
```

(c) Replace the `dayNodeWhere` block (lines 42-48) with:

```ts
// Shared WHERE clause for day-node lookups. `since`/`until` are inclusive
// bounds; an omitted bound is open on that side.
const dayNodeWhere = and(
  eq(nodes.userId, userId),
  eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
  sql`${nodeMetadata.label} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
  ...(since ? [gte(nodeMetadata.label, since)] : []),
  ...(until ? [lte(nodeMetadata.label, until)] : []),
);
```

(d) Remove the now-unused `date-fns` import (line 6: `import { format, subDays } from "date-fns";`). Confirm no other `format`/`subDays` use remains in the file (`grep -n "format\|subDays" src/lib/query/timeline.ts` → no hits).

- [ ] **Step 4: Run the handler test to verify it passes**

Run: `pnpm test --run src/lib/query/timeline.test.ts`
Expected: PASS (DB block requires Postgres up).

- [ ] **Step 5: Full type-check and SDK build**

Run: `pnpm run build:check && pnpm run build-sdk`
Expected: both PASS. `build-sdk` rebuilds `dist/{sdk,lib,types}` and runs `verify-sdk-build.mjs` green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/query/timeline.ts src/lib/query/timeline.test.ts
git commit -m "✨ feat(timeline): queryTimeline accepts open since/until bounds"
```

---

### Task 4: Auto-build the SDK before publish (`prepublishOnly`)

**Files:**

- Modify: `package.json` (`scripts`)

**Interfaces:**

- Produces: a `prepublishOnly` script that runs `pnpm run build-sdk`, so `pnpm publish` always rebuilds `dist` first.

- [ ] **Step 1: Add the hook**

In `package.json`, inside `"scripts"`, add (place it just above `"build-sdk"`):

```jsonc
    "prepublishOnly": "pnpm run build-sdk",
```

- [ ] **Step 2: Verify the hook runs the build**

Run: `pnpm run prepublishOnly`
Expected: it invokes `build-sdk` — tsc + tsc-alias emit `dist/`, then `verify-sdk-build.mjs` prints its success and exits 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "🔧 chore(release): build the SDK automatically before publish"
```

---

### Task 5: Changelog + consumer migration note

**Files:**

- Modify: `CHANGELOG.md` (`[Unreleased]`)
- Modify: `docs/sdk-consumer-migration.md` (prepend newest entry under the title block)

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the existing `[Unreleased]` timeline-periods bullet**

In `CHANGELOG.md`, in the `[Unreleased]` → `### Added` bullet that begins "**`/query/timeline` period summaries**", change the phrase "bounded by the same `startDate`/`endDate`" to "bounded by the same `since`/`until`".

- [ ] **Step 2: Add a breaking-change entry**

In `CHANGELOG.md`, under `## [Unreleased]`, add a new `### Changed` section (above `### Fixed`):

```markdown
### Changed

- **BREAKING: `queryTimeline` date bounds renamed `startDate`/`endDate` → `since`/`until`, with conventional semantics.** `since` is the earliest day (inclusive), `until` the latest (inclusive); both are optional and an omitted bound is open on that side (no more implicit `today` / 90-days-ago defaults). Previously `startDate` meant the _newest_ edge and `endDate` the _oldest_, which silently collapsed a one-sided window — e.g. `endDate: today` returned only today. `includePeriods` now derives week/month/year rollups from the day nodes actually in range, so an open `until: today` feed returns every past period it covers, not just the current one. Update callers: pass `until` for "up to" and `since` for "from".
```

- [ ] **Step 3: Add the consumer migration note**

In `docs/sdk-consumer-migration.md`, immediately after the `---` that follows the intro (before the first existing `##` entry), insert:

```markdown
## `queryTimeline` bounds renamed to `since` / `until` (breaking)

- `MemoryClient.queryTimeline({ ... })` no longer accepts `startDate` / `endDate`.
  Use `since` (earliest day, inclusive) and `until` (latest day, inclusive).
  Both optional; omit a bound for an open window. There is no implicit default
  window anymore.
- Semantics are now conventional (`since <= until`). The old `startDate` was the
  newest edge and `endDate` the oldest — the reverse — which collapsed one-sided
  windows. Concretely: a "today and older" feed is now `{ until: today }`
  (was, incorrectly, `{ endDate: today }`); a "tomorrow and newer" feed is
  `{ since: tomorrow }`.
- `includePeriods: true` returns the week/month/year rollups for the days in
  range (open bounds included), so past-period summaries now appear in a
  `{ until: today }` feed.

---
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/sdk-consumer-migration.md
git commit -m "📚 docs(timeline): changelog + migration note for since/until rename"
```

---

### Task 6: Final verification gate

**Files:** none (verification only).

- [ ] **Step 1: Run the full gate**

Run, from repo root, with Postgres up on `localhost:5431`:

```bash
pnpm run lint && pnpm run format && pnpm run build:check && pnpm run build-sdk && pnpm test --run
```

Expected: all green. If `format` reports issues, run `pnpm run format:fix`, re-run, and amend the most relevant commit.

- [ ] **Step 2: Confirm no stray `startDate`/`endDate` remain in the timeline surface**

Run: `grep -rn "startDate\|endDate" src/lib/schemas/query-timeline.ts src/lib/query/timeline.ts src/lib/query/timeline-periods.ts`
Expected: no matches. (Matches in `jobs/rollup.ts`, `queues.ts`, `schemas/rollup.ts` are the unrelated rollup param — leave them.)

---

## Release runbook (run only on explicit go-ahead — not part of normal execution)

After the branch is merged to `main`:

```bash
# from a clean main checkout
pnpm version major              # 1.29.0 -> 2.0.0: bumps package.json, commits, tags v2.0.0
pnpm publish                    # prepublishOnly rebuilds dist via build-sdk, then publishes
git push --follow-tags
```

(Optionally move the `[Unreleased]` changelog entries under a `## [2.0.0] — <date>` heading before tagging.)

## Follow-on (separate plan, after publish)

Petals consumer update (spec §6) — bump `@marcelsamyn/memory` to `^2.0.0`, switch the timeline hooks to `{ until: today }` / `{ since: tomorrow }` (removing the `TIMELINE_EPOCH`/`TIMELINE_FAR_FUTURE` sentinels), rename the `server/memory.ts` validator fields and `query-keys.ts` params, and align the mock. Written as its own plan once `2.0.0` is published.
