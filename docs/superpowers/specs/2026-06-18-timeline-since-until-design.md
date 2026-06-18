# `queryTimeline` — intuitive `since`/`until` window bounds

**Date:** 2026-06-18
**Status:** Approved (design)
**Repos:** `assistant-memory` (this change + SDK), `petals` (consumer follow-on)

## Problem

`queryTimeline`'s date bounds are named and defaulted counterintuitively, which
caused a production bug: every week/month/year recap in the Petals memory
timeline showed "no recap yet" even though the rollup nodes (e.g. `2026-W23`)
existed with real summaries.

Today the handler does:

```ts
const startDate = params.startDate ?? today; // startDate = NEWEST edge
const endDate = params.endDate ?? ninetyDaysAgo; // endDate   = OLDEST edge
const rangeMin = startDate < endDate ? startDate : endDate;
const rangeMax = startDate < endDate ? endDate : startDate;
```

So `startDate` is the _newest_ bound (default today) and `endDate` the _oldest_
(default 90 days ago) — the reverse of the universal `start ≤ end` convention.
Petals, reading the names the obvious way, called the feed with `endDate: today`
(meaning "newest = today"). The backend read that as "oldest = today", and with
`startDate` defaulting to today the window collapsed to `[today, today]`.
`loadTimelinePeriods` then only ever loaded the **current** week/month/year
keys; every past period was excluded. (The rail still looked populated because a
second, future-oriented feed sent `startDate: tomorrow`, which the backend
mis-resolved to `[90-days-ago, tomorrow]` and accidentally pulled ~90 days of
past days — but without `includePeriods`.)

`queryTimeline` is consumed **only by Petals** (the n8n node does not expose it;
no other repo references it), so we can correct the contract cleanly and update
the single consumer in lockstep.

## Goals

- Replace the bounds with conventional, self-explanatory names and semantics.
- Remove the magic `today` / `90-days-ago` defaults; an omitted bound means
  unbounded on that side.
- Make `includePeriods` return the rollup periods that cover the in-range days —
  including past periods — and do so without scanning whole calendar years.
- Keep pagination (`limit`/`offset`, newest-first) and `nodeTypes` filtering
  unchanged.

## Non-goals

- No change to pagination model, day/connected-node shaping, or `nodeTypes`.
- No change to how rollup summaries are written (`additionalData.rollup` gate).
- No Petals UI changes beyond adopting the new call shape (separate follow-on).

## Design

### Contract

`queryTimeline({ userId, since?, until?, limit?, offset?, nodeTypes?, includePeriods? })`

- `since` — earliest day to include, inclusive (`YYYY-MM-DD`). Omitted ⇒ no lower
  bound.
- `until` — latest day to include, inclusive (`YYYY-MM-DD`). Omitted ⇒ no upper
  bound.
- Days are returned newest-first and paginated by `limit`/`offset` (unchanged).
- `since`/`until` follow the `since ≤ until` convention; if inverted, the result
  is simply empty (no defensive swap — the names make intent unambiguous).

### 1. Schema — `src/lib/schemas/query-timeline.ts`

Rename `startDate` → `since`, `endDate` → `until` in `queryTimelineRequestSchema`
(same `YYYY-MM-DD` regex, still `.optional()`). Update `QueryTimelineRequest`.
Response schema is unchanged.

### 2. Day query — `src/lib/query/timeline.ts`

- Delete `today`, `ninetyDaysAgo`, `startDate`/`endDate` defaults, and the
  `rangeMin`/`rangeMax` swap.
- Build the day-node `WHERE` with conditional bounds:

```ts
const dayNodeWhere = and(
  eq(nodes.userId, userId),
  eq(nodes.nodeType, NodeTypeEnum.enum.Temporal),
  sql`${nodeMetadata.label} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
  ...(since ? [gte(nodeMetadata.label, since)] : []),
  ...(until ? [lte(nodeMetadata.label, until)] : []),
);
```

- Call `loadTimelinePeriods(db, userId, since, until)` (signature below).

### 3. Periods — `src/lib/query/timeline-periods.ts`

Derive the period set from the day labels actually present in range, instead of
iterating every calendar day in a window (which can't express open bounds and
scans years):

1. `SELECT DISTINCT nodeMetadata.label` for the user's `Temporal` day nodes
   (same `YYYY-MM-DD` regex + optional `since`/`until` bounds).
2. For each day label, collect `weekKeyForDay(label)`, `monthKeyForDay(label)`,
   and `yearKeyForMonth(monthKeyForDay(label))` into a `Set<string>` (helpers
   already exported from `rollup/period`).
3. Load the `Temporal` rollup nodes whose label ∈ that set (existing join +
   `readRollupMeta`-gated `summary`), as today.

Delete `periodKeysForWindow` (and its `eachDayOfInterval` use). Result: periods
exactly match the days the timeline can show, open bounds work for free, and the
scan is proportional to real data, not calendar span.

### 4. Tests — `assistant-memory`

- `schemas/query-timeline.test.ts`, `query/timeline.test.ts`,
  `query/timeline-periods.test.ts`: rename fields and rewrite to the intuitive
  `since ≤ until` ordering.
- **Regression test (the bug):** with day nodes spanning several past weeks and
  summarized rollup nodes for them, `queryTimeline({ until: today,
includePeriods: true })` returns the **past** week/month/year periods (e.g.
  `2026-W23`), not only the current ones.
- Open-bound tests: `since` only, `until` only, neither.

### 5. SDK + changelog

`memory-client.ts` forwards the payload unchanged, so only the schema/types
move. This is a **breaking field rename** on the published `@marcelsamyn/memory`
package → **major version bump**, with a `CHANGELOG.md` entry under a new version
heading describing the `startDate/endDate` → `since/until` rename and the
semantic correction. SDK consumer note added to `docs/sdk-consumer-migration.md`.

### 5b. Release flow (auto-build before publish)

Today nothing rebuilds `dist` at publish time — `pnpm publish` ships whatever is
already on disk, so a forgotten `pnpm run build-sdk` publishes a stale or
missing build. Fix it at the source with a lifecycle hook in `package.json`:

```jsonc
"scripts": {
  "prepublishOnly": "pnpm run build-sdk",
  // ...
}
```

`prepublishOnly` runs automatically before `pnpm publish` (not on install), so
the published tarball always contains a fresh `dist/{sdk,lib,types}` validated by
`verify-sdk-build.mjs`.

Release is driven through pnpm so the git tag is created in the same step:

1. `pnpm version major` — bumps `package.json` (1.29.0 → 2.0.0), creates the
   version commit and the `v2.0.0` git tag.
2. `pnpm publish` — `prepublishOnly` rebuilds the SDK, then the fresh build is
   published.
3. `git push --follow-tags`.

### 6. Petals consumer (follow-on, after the SDK publishes)

Tracked here for completeness; implemented in a separate Petals PR once the new
SDK major is published and the dep is bumped:

- `src/server/memory.ts` — rename validator fields to `since`/`until`; fix the
  docstring (drop "window-independent").
- `src/features/memory/hooks/use-memory-queries.ts` — remove the
  `TIMELINE_EPOCH` / `TIMELINE_FAR_FUTURE` sentinels; past feed
  `{ until: today, includePeriods: pageParam === 0 }`, future feed
  `{ since: tomorrow }`.
- `src/lib/memory-mock.ts` — params `{ since?, until? }`; natural
  `>= since` / `<= until` filtering; keep window-scoped periods.
- `src/lib/query-keys.ts` — rename `timeline(startDate?, endDate?)` params to
  `(since?, until?)` (cache-key shape unchanged).

## Rollout

1. **assistant-memory** (this branch): schema + query + periods + tests + SDK
   types + changelog + the `prepublishOnly` hook (§5b) → merge → release via
   `pnpm version major` + `pnpm publish` (auto-builds) + `git push
--follow-tags`.
2. **petals**: bump SDK dep to `^2.0.0`, apply §6, verify (build/lint/test + a
   timeline screenshot), open PR.

## Risks

- Breaking SDK rename — mitigated: Petals is the sole consumer, updated in
  lockstep; n8n node unaffected.
- Unbounded default windows now return all matching days for a COUNT; payload is
  still capped by `limit`/`offset` per page, and `COUNT` over the labelled
  Temporal nodes is cheap.
