# Temporal Rollup: Multi-Layer Summarization (Day → Week → Month → Year)

**Date:** 2026-06-12
**Status:** Approved design, pending implementation plan

## Problem

Ingested content links to day nodes (`Temporal` nodes labeled `yyyy-MM-dd`) via
`OCCURRED_ON` claims, but nothing summarizes those days, and no higher-level
temporal structure exists. We want a recursive summary hierarchy — day
summaries from raw content, weekly summaries from days, monthly from weeks,
yearly from months — so retrieval can answer "what happened in March?" and the
graph carries durable, searchable period narratives.

The trigger must be external (SDK/HTTP), never internally scheduled: the
hosted deployment serves Petals, which must control exactly when and how much
LLM spend each user (especially free-tier) incurs.

## Decisions (settled during brainstorming)

1. **Trigger shape:** catch-up sweep. One endpoint: "roll up everything stale
   for user X." No internal scheduling.
2. **No agentic exploration.** Deterministic input collection; one structured
   LLM completion per period. Token cost per call is bounded and predictable.
3. **Fully recursive hierarchy.** Days get LLM summaries first (written onto
   the day node), weeks read day summaries, months read weekly summaries,
   years read monthly summaries.
4. **Completed periods only.** A period is summarized only after it ends.
   Read-time views of the current day remain the job of `/digest`.
5. **Staleness via per-user watermark + input fingerprints.** No ingestion
   changes; backfill and crash recovery handled naturally.
6. **`startDate` floor.** The request can carry a `startDate`; periods ending
   before it are excluded outright, so a first sweep over an account with
   years of history doesn't pay for ancient periods.

## Data model

### Period nodes

All four layers are `Temporal` nodes (existing `NodeTypeEnum`), distinguished
by label convention. Labels are the lookup key (same convention as
`ensureDayNode` in `src/lib/temporal.ts`):

| Layer | Label format            | Example      | Completeness rule (lexicographic vs today's label) |
| ----- | ----------------------- | ------------ | -------------------------------------------------- |
| Day   | `yyyy-MM-dd` (existing) | `2026-06-08` | label < today                                      |
| Week  | ISO `RRRR-'W'II`        | `2026-W24`   | its Sunday's label < today                         |
| Month | `yyyy-MM`               | `2026-06`    | its last day's label < today                       |
| Year  | `yyyy`                  | `2026`       | its Dec 31 label < today                           |

Weeks are ISO weeks (Monday start, ISO week-numbering year via date-fns
`getISOWeek`/`getISOWeekYear`). "Today" uses the same server-side
`format(new Date(), "yyyy-MM-dd")` convention as `ensureDayNode`; per-user
timezones are out of scope (noted as a future refinement).

`ensureDayNode` is generalized to `ensurePeriodNode(db, userId, periodKey)`
in `src/lib/temporal.ts`: label-based lookup, create-if-missing with a
boilerplate description and a jina-embeddings-v3 embedding, exactly like day
nodes today.

### Summary storage

- `nodeMetadata.description` ← the summary text (day nodes' boilerplate
  "Represents the day X" gets replaced; week/month/year nodes start with
  boilerplate and get replaced the same way).
- `nodeMetadata.additionalData.rollup` ← `{ fingerprint, summarizedAt }`.
- `nodeEmbeddings` ← re-embedded as `${label}: ${description}` whenever the
  description changes (upsert), so period summaries are vector-searchable.

### Containment edges

Claims with the **existing** `PART_OF` predicate (already in
`RelationshipPredicateEnum`), `assertedByKind: "system"`, `scope: "personal"`,
ensured idempotently when the sweep processes a period (each existing child
node gets a `PART_OF` claim to the parent; `statement` e.g.
`"2026-06-08 is part of week 2026-W24"`). Day nodes predate the rollup, so
claims are attached at sweep time, not at node creation:

- day `PART_OF` week — exactly 1
- week `PART_OF` month — 1 per overlapping month (a week straddling a month
  boundary gets 2)
- month `PART_OF` year — exactly 1

**Week/month overlap rule:** ISO weeks do not nest in months. A month's input
is every ISO week that overlaps it (4–6 weeks); the month prompt is told which
days of boundary weeks fall inside the month. Years read months, so no
straddling exists at the year level.

`claims.sourceId` is NOT NULL, so containment claims need a source: add
`"rollup"` to the `SourceType` union (`src/types/graph.ts` — varchar column,
no DB migration) and idempotently ensure one synthetic source per user
(`externalId: "rollup"`), following the precedent of
`src/lib/metrics/sources.ts`. All rollup-created claims use it.

### Sweep state

New table `rollup_state`:

| Column           | Type                     | Notes                                  |
| ---------------- | ------------------------ | -------------------------------------- |
| `userId`         | text PK, FK → users      | one row per user                       |
| `watermark`      | timestamptz, nullable    | max `claims.createdAt` fully processed |
| `pendingPeriods` | jsonb (string[])         | period keys awaiting summarization     |
| `updatedAt`      | timestamptz              |                                        |

## Sweep algorithm

Runs as one BullMQ job per trigger. Inputs: `userId`, `maxLlmCalls`,
`startDate?`.

1. **Discover.** Load `rollup_state`. Query active `OCCURRED_ON` claims with
   `createdAt > watermark` (all claims if watermark is null), join to the
   object node's metadata label → distinct day labels touched. Record the max
   `createdAt` seen as the new watermark candidate.
2. **Expand.** Work set = touched days ∪ their ancestor weeks/months/years ∪
   `pendingPeriods`.
3. **Filter.** Drop periods whose end < `startDate` (when given) — removed
   from the work set *and* purged from `pendingPeriods` (excluded, not
   deferred). Periods not yet complete move to `pendingPeriods` (deferred —
   this is what makes "user goes quiet mid-week" safe: the week sits in
   pending until a later sweep finds it complete, even if no new claims ever
   arrive).
4. **Process bottom-up,** oldest first within each level: all days, then
   weeks, months, years. Per period:
   - Collect input (see below) and compute its fingerprint (sha256 of the
     exact compacted input text).
   - If the stored fingerprint matches and a summary exists → skip (no LLM
     call, does not count against the budget).
   - Otherwise: one `parseStructuredCompletion` call (task
     `"temporal_summary"`), write description + `additionalData.rollup`,
     re-embed, ensure containment claims. Counts 1 against `maxLlmCalls`.
   - On per-period failure: log loudly, leave the period in
     `pendingPeriods`, continue with the rest (one poison period must not
     block the sweep).
   - When the budget is exhausted: stop; all unprocessed periods go to
     `pendingPeriods`.
5. **Commit state.** Watermark ← candidate from step 1 (always advances —
   deferred/over-budget/failed work is carried by `pendingPeriods`, never by
   holding the watermark back). Persist `pendingPeriods`.

Backfill works without ingestion changes: importing old content creates *new*
claims (fresh `createdAt`) pointing at *old* day nodes, so the old day
re-enters the work set, its summary changes, the week's input fingerprint
changes, and the change cascades up. If the day's effective input is
unchanged, every level fingerprint-skips at zero LLM cost.

## Input collection per level

All collection is deterministic SQL + string assembly — no LLM involvement
until the single summarization call.

- **Day:** nodes linked to the day node via active `OCCURRED_ON` claims;
  for each, label + description (+ a bounded number of associated claim
  statements). Compacted deterministically: initial caps of 600 chars per
  node entry and 24,000 chars total day input (constants in
  `src/lib/rollup/collect.ts`, tunable); overflow is dropped by recency
  priority and the prompt is told content was truncated. Bounds even heavy
  days (e.g. screenpipe distiller documents).
- **Week:** the descriptions of its 7 day nodes. Days with no node or no
  summary are listed as "no summarized activity."
- **Month:** descriptions of all overlapping weeks, annotated with which of
  each week's days fall inside the month.
- **Year:** descriptions of its 12 month nodes (missing months listed as "no
  summarized activity").

Output schema per call (Zod, via `zodResponseFormat` — mind the zod4/openai6
constraints: `.nullish()` over `.optional()`, no `.transform()`):

```ts
z.object({
  summary: z
    .string()
    .describe("Narrative summary of the period; concrete, specific, past tense"),
});
```

Prompts differ per level (day: synthesize events/themes from raw content;
week: narrate the arc of the week from day summaries; month/year: progressive
abstraction — themes, changes, milestones over the children).

## API, SDK, job

### `POST /rollup`

Request (`src/lib/schemas/rollup.ts`):

```ts
{
  userId: string;
  maxLlmCalls?: number; // default 50; each period summary costs 1
  startDate?: string;   // "yyyy-MM-dd"; periods ending before this are excluded
}
```

Behavior mirrors `src/routes/summarize.ts`: validate, enqueue a `"rollup"`
job on `batchQueue` with `jobId: rollup:${userId}` (BullMQ-level dedup — concurrent
triggers for the same user collapse while one is queued/running), return an
"enqueued" message immediately. Job options: 3 attempts, exponential backoff
(matching `SUMMARIZE_JOB_OPTIONS`).

The SDK gains a `rollup(request)` method via the existing schema-driven
client pattern (`src/sdk/memory-client.ts`).

### Cost model (the Petals free-tier story)

- A period costs **one LLM call ever**, unless its input genuinely changes.
- A sweep with nothing stale costs **zero** LLM calls.
- `maxLlmCalls` hard-caps each sweep; leftovers resume on the next call.
- `startDate` caps history depth on first contact with a backlogged account.
- Petals owns cadence entirely: call rarely/low-budget for free users,
  frequently for paid. Spend is attributable per task/user via the existing
  Helicone telemetry (`task: "temporal_summary"`).

### Model routing

Add `"temporal_summary"` to `ModelTask` (`src/utils/models.ts`) with a
`MODEL_ID_TEMPORAL_SUMMARY` env override (`src/utils/env.ts`), falling back to
`MODEL_ID_GRAPH_EXTRACTION` per the existing pattern. One task for all four
levels; Helicone breaks down spend by task.

## New/changed files

| File                                   | Change                                                     |
| -------------------------------------- | ---------------------------------------------------------- |
| `src/lib/rollup/period.ts`             | new — pure period math: keys, ancestors, ranges, completeness |
| `src/lib/rollup/collect.ts`            | new — input collection, compaction, fingerprinting          |
| `src/lib/jobs/rollup.ts`               | new — the sweep job                                         |
| `src/lib/schemas/rollup.ts`            | new — request/response Zod schemas                          |
| `src/routes/rollup.post.ts`            | new — HTTP trigger                                          |
| `src/lib/temporal.ts`                  | generalize `ensureDayNode` → add `ensurePeriodNode`         |
| `src/db/schema.ts`                     | add `rollup_state` table (+ drizzle migration)              |
| `src/types/graph.ts`                   | add `"rollup"` to `SourceType`                              |
| `src/utils/models.ts`, `src/utils/env.ts` | add `temporal_summary` task + env override               |
| `src/lib/queues.ts`                    | register `"rollup"` job + options                           |
| `src/sdk/memory-client.ts`             | add `rollup()` method                                       |

## Testing

- **Unit (pure functions):** period math — day→week/month/year key
  derivation, ISO edge cases (W01 spanning a year boundary, W53 weeks,
  month/week overlap sets, completeness vs a fixed "today"); fingerprint
  stability; watermark/pending-set transitions including `startDate`
  filtering and purge-from-pending.
- **Integration (vitest, test DB on :5431, mocked LLM):** seed OCCURRED_ON
  claims across a multi-week range → run the job → assert period nodes,
  `PART_OF` claims, descriptions, embeddings; second run fingerprint-skips
  (zero LLM calls); budget exhaustion defers to `pendingPeriods` and resumes;
  backfilled claim re-summarizes the old day and cascades; `startDate`
  excludes old periods.
- CI does not run vitest — run tests locally.

## Out of scope (explicitly)

- Per-user timezones for period boundaries.
- Summarizing in-progress periods (current day/week/month/year).
- Agentic/tool-use summarization.
- Internal scheduling of sweeps.
- A `/query/week`-style read endpoint (period summaries surface via existing
  vector search; dedicated read endpoints can come later if Petals needs them).
