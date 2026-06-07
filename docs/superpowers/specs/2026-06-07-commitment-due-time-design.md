# Commitment Due Time + Timezone — Design

**Date:** 2026-06-07
**Status:** Approved (pending spec review)
**Author:** Memory team

## Goal

Let a commitment's due date carry an optional **time of day** and **timezone**, so
a `Task` can be due "2026-06-10 at 17:00 in America/New_York" rather than only
"2026-06-10". The time must:

- **Display faithfully** across the LLM context, detail, and list read models.
- **Resolve to an absolute instant** so a future/external scheduler can fire on it.
- **Drive intraday overdue logic** — a task due today at 09:00 becomes overdue once
  09:00 passes in the caller's zone.
- **Stay unambiguous and DST-safe** when read from any zone (cross-timezone
  correctness).

This explicitly supersedes the prior "No due **time** — `DUE_ON` is date-only, and
we keep it that way" non-goal recorded in
`docs/superpowers/specs/2026-06-06-commitment-manager-sdk-design.md`.

## Non-goals (YAGNI)

- **No natural-language due-_time_ inference in the ingestion extractor.** The
  extractor (`src/lib/extract-graph.ts`) may still emit date-only `DUE_ON` claims;
  parsing times/zones from prose (and inferring an absent zone) is a separate
  LLM-prompt effort. Out of scope.
- **No reminder scheduler.** None exists in the repo. We persist a *resolvable
  instant*; wiring an actual cron/notification job is future work.
- **No stored user-level timezone / user settings.** Matching the digest's existing
  convention, the zone is provided by the caller per write. A user-default zone
  would be a new settings concept — out of scope.
- **No recurrence, no duration/“ends at”, no all-day-vs-timed flag** beyond
  "time absent = date-only". Absence of a time already means all-day.
- **No second/sub-minute granularity.** Times are `HH:mm` (minute precision).
- **No new node types.** The date stays a shared day-granularity `Temporal` node;
  the time lives on the claim.

## Decisions (resolved during brainstorming)

1. **Purpose:** all four of display, reminders, overdue querying, cross-tz
   correctness. → store both human truth *and* a resolvable instant.
2. **Query scope:** full instant querying. → the resolved instant must be
   **persisted and indexed**, not merely computed on read.
3. **Instant storage:** a nullable `timestamptz` column on the existing `claims`
   table (Approach A), chosen over a side table (extra join on every read) and over
   compute-on-read (no index). Reads already alias the `DUE_ON` claim row, so the
   column adds zero new joins.

## Background: what exists today (unchanged unless noted)

- **Due date model:** a `DUE_ON` claim links a `Task` node → a shared, day-granularity
  `Temporal` node whose `node_metadata.label` is the literal `YYYY-MM-DD`. Resolved
  via `ensureDayNode` (`src/lib/temporal.ts`). The date string is read off that
  label across every surface. The day node is **shared** across many subjects, so
  time-of-day cannot live on it — it must live on the claim.
- **Supersession:** `DUE_ON` on a `Task` subject is `single_current_value` +
  `supersede_previous` (`src/lib/claims/predicate-policies.ts`). Asserting a new
  `DUE_ON` supersedes the prior active one automatically. `dueOn: null` retracts.
- **`claims.metadata` (jsonb):** present in the table but **currently unwritten and
  unread** by any claim path (verified). Free to use for the human-truth payload.
- **`claims` object XOR:** `claims_object_shape_xor_ck` requires exactly one of
  `object_node_id` / `object_value`. `DUE_ON` uses `object_node_id` (the day node);
  the new instant column and `metadata` are independent of that constraint.
- **Timezone convention:** `src/lib/digest/time-zone.ts` provides Intl-based helpers
  (`isValidTimeZone`, `startOfDayInTimeZone`) — no external tz library; `date-fns-tz`
  is not a dependency. The digest schema/route already accept a caller `timeZone`
  and validate it with `isValidTimeZone`.
- **Read surfaces returning `dueOn`:** `getOpenCommitments` /
  `getCandidateCommitments` (`src/lib/query/open-commitments.ts`),
  `listCommitments` (`src/lib/query/commitments-list.ts`), `getCommitment`
  (`src/lib/query/commitment-detail.ts`), the digest (`src/lib/digest/get-digest.ts`,
  which reuses `openCommitmentSchema` for its buckets), and the LLM context section
  (`src/lib/context/sections/open-commitments.ts`).
- **Write surfaces:** `createCommitment`, `setCommitmentDue` (`src/lib/commitments.ts`).
- **Generic claim writer:** `createClaim` (`src/lib/claim.ts`) — does **not** today
  persist `metadata`, and there is no `object_instant` column yet.

## Data model

The `DUE_ON` claim keeps `object_node_id` → the shared `YYYY-MM-DD` day node. We add:

- **Human truth → `claims.metadata`:**
  ```jsonc
  { "dueTime": "HH:mm", "timeZone": "<IANA>" }   // e.g. { "dueTime": "17:00", "timeZone": "America/New_York" }
  ```
  Canonical, DST-safe, recomputable. Absent ⇒ date-only (today's behavior).
- **Derived index → `claims.object_instant` (new, nullable `timestamptz`):**
  the UTC instant of `<dayLabel>T<dueTime>` interpreted in `timeZone`. Denormalized
  for indexed instant-range queries; recomputable from the canonical fields.

Both are `NULL` for date-only and non-temporal claims. **No backfill** — existing
date-only `DUE_ON` claims are valid as-is.

**Invariants** (enforced at the commitments boundary, not in `createClaim`):

- `dueTime` present ⟺ `timeZone` present ⟺ `object_instant` non-null.
- A time requires a date (`dueOn`); a time is rejected when `dueOn` is `null`.
- `object_instant === instantFromLocalTime(dueOn, dueTime, timeZone)` by construction,
  so formatting `object_instant` back in `timeZone` reproduces exactly `dueOn` + `dueTime`.

## Component changes

### 1. Migration & DB schema

`src/db/schema.ts` — add to the `claims` table:

```ts
objectInstant: timestamp("object_instant", { withTimezone: true }),
```

and a partial index for instant-range scans of current due claims:

```ts
index("claims_due_instant_idx")
  .on(table.userId, table.objectInstant)
  .where(sql`${table.predicate} = 'DUE_ON' AND ${table.status} = 'active' AND ${table.scope} = 'personal' AND ${table.objectInstant} IS NOT NULL`),
```

Generate the migration with `pnpm run drizzle:generate` (→ `drizzle/0018_*.sql`),
review the SQL, apply with `pnpm run drizzle:migrate`. The generated DDL is the
single source of truth in CI; do not hand-edit the schema diff.

> Column name rationale: `object_instant` describes "the resolved instant of a
> time-qualified temporal-object claim" without hard-coding `DUE_ON`, mirroring the
> table's existing predicate-specific partial indexes and `valid_from`/`valid_to`
> temporal columns. It is **not** a generic feature for all claims — only `DUE_ON`
> writes it today — but the neutral name avoids implying otherwise in the column list.

### 2. Timezone helper

Promote `src/lib/digest/time-zone.ts` → **`src/lib/time-zone.ts`** (it is no longer
digest-specific). Update both importers:
`src/lib/digest/get-digest.ts` and `src/lib/schemas/digest.ts`.

Add a generalized resolver and refactor the existing one to delegate:

```ts
/** UTC instant for `time` (HH:mm) local on `date` (YYYY-MM-DD) in `timeZone`. */
export function instantFromLocalTime(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const utcGuess = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0);
  const offset = zoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

export function startOfDayInTimeZone(date: string, timeZone: string): Date {
  return instantFromLocalTime(date, "00:00", timeZone);
}
```

> **Documented DST limitation:** the single offset-correction picks a deterministic
> instant; in the ~1 hour/year windows where a wall-clock time is skipped
> (spring-forward) or repeated (fall-back) it resolves to one consistent
> interpretation rather than erroring. This is the same approximation
> `startOfDayInTimeZone` already ships, and is acceptable for minute-grained due
> times. Covered explicitly by tests so the behavior is pinned, not accidental.

### 3. Shared DUE_ON metadata schema

New `src/lib/schemas/due-claim-metadata.ts` — the parse-at-boundary shape used by
both the write and read layers:

```ts
export const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:mm, 24h
export const dueClaimMetadataSchema = z.object({
  dueTime: z.string().regex(DUE_TIME_PATTERN),
  timeZone: z.string().refine(isValidTimeZone, "Invalid IANA time zone"),
});
export type DueClaimMetadata = z.infer<typeof dueClaimMetadataSchema>;
```

### 4. Generic claim writer

`src/lib/claim.ts` — extend `CreateClaimInput` and the insert (`createClaim` stays
"dumb"; it persists what it's given and does not enforce due-specific coherence):

```ts
metadata?: Record<string, unknown> | undefined;
objectInstant?: Date | undefined;
```

Both added to the `.values({ ... })` insert. No other behavior changes.

### 5. Write path — `setCommitmentDue` & `createCommitment` (`src/lib/commitments.ts`)

Request-schema additions (`set-commitment-due.ts`, `create-commitment.ts`):

```ts
dueTime: z.string().regex(DUE_TIME_PATTERN, "dueTime must be HH:mm").nullish(),
timeZone: z.string().refine(isValidTimeZone, "Invalid IANA time zone").nullish(),
```

Cross-field `.refine`s:

- `dueTime` and `timeZone` are **mutually required**: providing one without the
  other is rejected (a zone with no time is a silent no-op; a time with no zone is
  ambiguous).
- For `setCommitmentDue`: `dueTime`/`timeZone` must be absent/null when `dueOn` is
  `null` (clearing).
- For `createCommitment`: `dueTime` requires `dueOn` present.

A private module helper resolves the pair (two in-module callers ⇒ justified):

```ts
function resolveDueQualifier(dueOn: string, dueTime?: string | null, timeZone?: string | null):
  { metadata?: Record<string, unknown>; objectInstant?: Date } {
  if (!dueTime || !timeZone) return {};
  return { metadata: { dueTime, timeZone }, objectInstant: instantFromLocalTime(dueOn, dueTime, timeZone) };
}
```

The resolved `metadata` + `objectInstant` are passed through to `createClaim`. The
claim `statement` includes the time when present, e.g.
`Task due on 2026-06-10 at 17:00 (America/New_York)`. Supersession is unchanged:
rescheduling asserts a fresh claim; `dueOn: null` retracts all; a date with no time
re-asserts a date-only claim (clearing any prior time).

Response-schema additions (both write ops): `dueTime: string | null`,
`timeZone: string | null`, `dueAt: (coerce date) | null`.

### 6. Read paths

A small shared mapper turns a joined due row into the three fields, so every read
surface stays consistent and resilient:

```ts
// from dueClaim.metadata (jsonb) + dueClaim.objectInstant (Date|null)
function readDueQualifier(metadata: unknown, objectInstant: Date | null):
  { dueTime: string | null; timeZone: string | null; dueAt: Date | null } {
  const parsed = dueClaimMetadataSchema.safeParse(metadata ?? undefined);
  if (!parsed.success) return { dueTime: null, timeZone: null, dueAt: objectInstant ?? null };
  return { dueTime: parsed.data.dueTime, timeZone: parsed.data.timeZone, dueAt: objectInstant ?? null };
}
```

Malformed metadata degrades to date-only with a `console.warn` (mirroring the
`coerceTaskStatus` resilience pattern) — a single bad row never 500s a read.

- **`open-commitments.ts`** (`getOpenCommitments` / `getCandidateCommitments`):
  select `dueClaim.metadata` + `dueClaim.objectInstant`; map via `readDueQualifier`;
  push `dueTime`/`timeZone`/`dueAt`. Schema (`open-commitments.ts`) gains:
  ```ts
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
  ```
  This automatically enriches the **digest buckets** (they reuse `openCommitmentSchema`).
- **`commitment-detail.ts`** (`getCommitment`): derive the three fields from the
  active `DUE_ON` claim; add them to `get-commitment.ts` response. History entries
  stay as-is (date label) — surfacing per-entry times is out of scope.
- **`commitments-list.ts`** (`listCommitments`):
  - Select + map the three fields onto each list item (`list-commitments.ts` item
    schema gains them).
  - **New request filters:** `dueBeforeInstant` / `dueAfterInstant`
    (`z.string().datetime().pipe(z.coerce.date())`), applied as range predicates on
    `object_instant`. They match **timed tasks only** (date-only tasks have no
    instant and are excluded from instant filters). The existing date-level
    `dueBefore` / `dueAfter` (compared against the day label) are unchanged.
  - **New sort key `dueAt`:** orders by `object_instant`, nulls-last, id-tiebreak —
    reuses the existing `dueOn` null-handling/keyset machinery (cleaner than making
    the date-level `dueOn` sort time-aware, which would require encoding a second
    value in the cursor). `commitmentSortEnum` gains `"dueAt"`; `sortColumns` maps it
    to `object_instant`; `sortValueOf` renders it as an ISO string.

### 7. Digest bucketing (`src/lib/digest/get-digest.ts`)

`bucketCommitments` becomes instant-aware while preserving date-only behavior.
Compute caller-frame boundaries once:

```
todayEnd        = startOfDayInTimeZone(shiftIsoDate(date, 1), timeZone)               // exclusive
upcomingEndExcl = startOfDayInTimeZone(shiftIsoDate(date, upcomingWithinDays + 1), timeZone)
now             = generatedAt
```

Per commitment:

- **Timed** (`dueAt !== null`):
  - `dueAt < now` → **overdue**
  - else `dueAt < todayEnd` → **dueToday**
  - else `dueAt < upcomingEndExcl` → **upcoming**
  - else → omitted (beyond horizon)
- **Date-only** (`dueOn !== null`): current string logic —
  `dueOn < date` overdue · `dueOn === date` dueToday · `dueOn <= upcomingUntil` upcoming.
- **No due** → omitted (current behavior).

This yields the intraday-overdue semantics: a task due today 09:00 sits in
`dueToday` until 09:00 (caller zone) passes, then moves to `overdue`.

### 8. Context section (`src/lib/context/sections/open-commitments.ts`)

Render `due=YYYY-MM-DD HH:mm <timeZone>` when timed, else `due=YYYY-MM-DD`.

### 9. SDK & docs

`MemoryClient` methods are typed off the shared request/response schemas, so their
signatures update automatically once the schemas change (all relevant schema modules
are already re-exported from `src/sdk/index.ts`). Update:

- doc comments on `setCommitmentDue` / `createCommitment` (mention `dueTime`/`timeZone`),
- `docs/sdk/commitments.md`,
- `CHANGELOG.md` (+ a minor version bump consistent with prior commits).

## Validation & error handling

- All input validated at the Zod boundary: `HH:mm` regex, IANA zone via
  `isValidTimeZone`, and the cross-field refinements above. Invalid input → route
  `parse` throws → 400 (existing pattern). No bespoke validation downstream.
- Reads parse `claims.metadata` defensively (`safeParse`) and degrade malformed
  rows to date-only with a warning — never a 500.
- `TaskNotFoundError` (404) and supersession behavior are unchanged.

## Testing

Run locally against the test DB on **:5431** (CI does not run vitest; it runs
lint/format/build only).

- **`src/lib/time-zone.test.ts`** (moved + extended): `instantFromLocalTime` basic
  cases; DST spring-forward (e.g. `America/New_York` 2026-03-08 02:30 — skipped hour)
  and fall-back (2026-11-01 01:30 — repeated hour); a non-US zone (e.g.
  `Asia/Kolkata` +05:30, `Pacific/Chatham` +12:45); `startOfDayInTimeZone` parity
  with the pre-refactor result.
- **`src/lib/commitments.test.ts`**: set/create with `dueTime`+`timeZone` persists
  the metadata and `object_instant`; `dueTime` without `timeZone` is rejected; time
  rejected when `dueOn: null`; clearing nulls both; rescheduling supersedes; date-only
  path unchanged.
- **Schema tests** (`set-commitment-due.test.ts` new, `create-commitment.test.ts`):
  the new refinements accept/reject the right shapes.
- **`open-commitments.test.ts`**: read mapping returns `dueTime`/`timeZone`/`dueAt`;
  date-only rows return nulls; malformed metadata degrades to date-only.
- **`commitments-list.test.ts`**: field mapping; `dueBeforeInstant`/`dueAfterInstant`
  filters; `dueAt` sort with keyset pagination across mixed timed/date-only rows.
- **Digest test**: timed task flips dueToday→overdue across `now`; date-only fallback
  unchanged; `upcoming` horizon respected.

## Backward compatibility

- Additive only: new nullable column, new optional request fields, new response
  fields that are `null` for existing data.
- Existing date-only `DUE_ON` claims keep working with no migration of data.
- Existing date-level filters/sorts (`dueBefore`/`dueAfter`/`dueOn` sort) are
  untouched; instant filters and the `dueAt` sort are strictly additional.

## File-by-file change summary

| File | Change |
| --- | --- |
| `src/db/schema.ts` | + `object_instant` column + `claims_due_instant_idx` partial index |
| `drizzle/0018_*.sql` | generated migration (column + index) |
| `src/lib/time-zone.ts` | **moved** from `src/lib/digest/`; + `instantFromLocalTime`; `startOfDayInTimeZone` delegates |
| `src/lib/digest/get-digest.ts` | import path update; instant-aware `bucketCommitments` |
| `src/lib/schemas/digest.ts` | import path update |
| `src/lib/schemas/due-claim-metadata.ts` | **new** shared `dueClaimMetadataSchema` |
| `src/lib/claim.ts` | `CreateClaimInput` + insert gain `metadata`, `objectInstant` |
| `src/lib/commitments.ts` | `resolveDueQualifier`; write `dueTime`/`timeZone`/instant; richer statement; responses echo new fields |
| `src/lib/schemas/set-commitment-due.ts` | request `dueTime`/`timeZone` + refines; response `dueTime`/`timeZone`/`dueAt` |
| `src/lib/schemas/create-commitment.ts` | same additions |
| `src/lib/query/open-commitments.ts` | select/map metadata + instant; `readDueQualifier` |
| `src/lib/schemas/open-commitments.ts` | item schema + `dueTime`/`timeZone`/`dueAt` |
| `src/lib/query/commitment-detail.ts` | derive new fields from active due claim |
| `src/lib/schemas/get-commitment.ts` | response + new fields |
| `src/lib/query/commitments-list.ts` | select/map; instant filters; `dueAt` sort |
| `src/lib/schemas/list-commitments.ts` | request `dueBeforeInstant`/`dueAfterInstant`, sort enum `dueAt`; item fields |
| `src/lib/context/sections/open-commitments.ts` | render time + zone |
| `src/sdk/memory-client.ts` | doc-comment updates (types flow from schemas) |
| `docs/sdk/commitments.md`, `CHANGELOG.md` | docs + version bump |
| tests | as listed above |

## Open questions

None outstanding — purpose, query scope, and storage are resolved above.
