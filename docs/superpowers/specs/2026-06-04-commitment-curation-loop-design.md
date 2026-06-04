# Commitment Curation Loop — Design

**Date:** 2026-06-04
**Status:** Approved (pending spec review)
**Related:** `2026-04-24-claims-layer-design.md` (claims/lifecycle/predicate policies), the `createCommitment` mutation added 2026-06-04.

## Problem

Commitments (`Task` nodes + `HAS_TASK_STATUS` claims) come from two places: the ingestion graph extractor (automatic) and, as of 2026-06-04, the `createCommitment` mutation (deliberate, LM/SDK-driven). Two gaps remain:

1. **Inferred commitments are invisible and un-actionable.** When the extractor is unsure ("the user _might_ be committing to X"), it stamps the `HAS_TASK_STATUS` claim `assertedByKind: "assistant_inferred"`. `getOpenCommitments` deliberately filters those out (`ne(claims.assertedByKind, "assistant_inferred")`). They exist in the graph but nothing surfaces them and there is no way to confirm or reject one.
2. **The extractor duplicates them.** Extractor prompt seeding (`_formatOpenCommitmentsSection`) is fed from `getOpenCommitments` (trusted-only), so the extractor is blind to existing _inferred_ tasks. When the same thing resurfaces it mints a **new** Task node instead of reusing the existing one. Identity resolution by canonical label catches some, not reliably.

The goal is a curation loop: inferred commitments are **candidates**; they can be surfaced, confirmed, or dismissed; corroboration promotes them automatically; and the extractor stops duplicating them.

## Key insight: the confidence axis already exists

We do **not** add a confidence dimension. `assertedByKind: "assistant_inferred"` _is_ the candidate marker, and the lifecycle already encodes the trust ordering we need:

```
user = 5, user_confirmed = 5, participant = 4, document_author = 3, assistant_inferred = 2, system = 1
```

`HAS_TASK_STATUS` is `single_current_value` / `supersede_previous`. So a `user`/`user_confirmed` status claim supersedes an `assistant_inferred` one for the same task — promotion is just supersession by a higher-trust assertion. The cleanup job's `promoteAssertion` already does exactly this (stamps `user_confirmed`).

## Decisions (from brainstorming)

- **Scope:** full curation loop — surface candidates + confirm/dismiss + convergence fix.
- **Confirm trigger:** proactive (bootstrap surfaces candidates; assistant raises them in chat) **plus** auto-promote on corroboration (emergent from the convergence fix + lifecycle trust).
- **Dismiss:** retract the active `HAS_TASK_STATUS` claim only. No sticky rejection marker. Re-surfacing after a much-later re-inference is accepted.
- **No schema or enum changes.** No new `TaskStatus` value, no migration, `claims.metadata` untouched.

## Non-goals / out of scope

- Numeric per-claim confidence in `claims.metadata` (can layer on later if the binary inferred flag proves too coarse).
- A sticky "user rejected this" marker that survives re-ingestion.
- Any new `TaskStatus` enum value or claim predicate.

## Architecture

Five components. Net new surface: ~2 lib fns + 1 query refactor + 1 bootstrap section + 2 routes/SDK methods/MCP tools + an extractor-seeding change.

### 1. Candidate read model

Refactor the `getOpenCommitments` query core (`src/lib/query/open-commitments.ts`) to take a provenance selector instead of hard-coding the trusted filter:

```ts
type CommitmentProvenance = "trusted" | "candidate";
// internal: _queryCommitments({ userId, provenance, ownedBy?, dueBefore? })
//   "trusted"   → ne(assertedByKind, "assistant_inferred")   (current behavior)
//   "candidate" → eq(assertedByKind, "assistant_inferred")
```

- `getOpenCommitments(params)` keeps its current public signature and calls the core with `provenance: "trusted"`.
- New `getCandidateCommitments(params)` calls the core with `provenance: "candidate"`. Returns the same `OpenCommitment` shape (latest active personal `HAS_TASK_STATUS` = `assistant_inferred`, status pending/in_progress).
- The OWNED_BY / DUE_ON metadata sub-joins are NOT symmetric with the status filter. The trusted path keeps `ne(assistant_inferred)` (trusted metadata only); the candidate path applies NO provenance constraint, so a candidate task surfaces its owner/due whether those claims are inferred OR trusted (e.g. a user-set due date on a not-yet-confirmed candidate must not be hidden). A naive "invert to `eq(assistant_inferred)`" would drop trusted metadata on candidates.

### 2. Bootstrap "candidates to confirm" section

Add an optional `candidate_commitments` section to the `ContextBundle` (`src/lib/context/types.ts` + a new section assembler in `src/lib/context/sections/`, mirroring the existing open-commitments section). Skipped when empty. Populated via `getCandidateCommitments`. The model-facing copy frames these as _unconfirmed_ — the assistant should raise them for confirmation, not state them as settled fact.

### 3. Confirm / dismiss surface

Two lib functions in `src/lib/commitments.ts`, both verifying the subject is a `Task` owned by the user (reuse `TaskNotFoundError`):

- `confirmCommitment({ userId, taskId })` — read the task's active `HAS_TASK_STATUS`; create a superseding claim with the **same status value** but `assertedByKind: "user_confirmed"` and `statedAt: now`. Lifecycle supersedes the prior (inferred) claim; the task now passes the trusted filter and appears in `getOpenCommitments`. Idempotent-ish: confirming an already-trusted task simply re-affirms it.
- `dismissCommitment({ userId, taskId })` — retract every active `HAS_TASK_STATUS` claim on the task (status → `retracted`), mirroring `setCommitmentDue`'s clear path. The task drops out of _both_ the candidate and open views (both require an active `HAS_TASK_STATUS`). The Task node remains and is left to orphan pruning.

Transport: routes `POST /commitments/confirm` and `POST /commitments/dismiss`; SDK `confirmCommitment` / `dismissCommitment`; MCP tools `confirm_commitment` / `dismiss_commitment` (descriptions pinned in `tool-descriptions.test.ts`). Schemas: `{ userId, taskId }` request; response echoes `taskId`, resulting `status`/visibility, and affected claim ids.

### 4. Convergence fix (extractor seeding)

In `extract-graph.ts`, additionally fetch `getCandidateCommitments` and render candidates in `_formatOpenCommitmentsSection` under a distinct heading, e.g.:

```
CANDIDATE TASKS (unconfirmed — the assistant inferred these; treat as tentative):
- existingNodeId: <id>; label: <label>; status: <status>
  If THIS source shows the user explicitly stating, acting on, or agreeing to this task,
  emit a HAS_TASK_STATUS attribute claim with assertionKind "user" against this existingNodeId
  (this confirms it). If the source completes/abandons it, emit the matching status. Never
  create a new Task node for one of these.
```

This:

- **Dedupes:** the extractor reuses the candidate's node id instead of minting a duplicate.
- **Auto-promotes:** a `user`-asserted status against the existing node supersedes the inferred one (trust 5 > 2), so corroboration promotes the candidate with no separate mechanism.

### 5. Assistant-proposed candidates (no code)

Already supported: `create_commitment`'s existing optional `assertedByKind` lets the assistant mint a candidate by passing `"assistant_inferred"` (hidden from open commitments, shown in candidates). Action item is documentation only — note this in the `create_commitment` tool description so the model knows the option exists.

## Data flow

1. **Ingestion** → uncertain commitment → `HAS_TASK_STATUS` (`assistant_inferred`) → candidate.
2. **Bootstrap** → `candidate_commitments` section lists it → assistant raises it in chat.
3. **User confirms** → `confirm_commitment` → superseding `user_confirmed` claim → now in `getOpenCommitments`.
   **User dismisses** → `dismiss_commitment` → retract → gone from both views.
4. **Re-ingestion corroborates** (user explicitly states it) → extractor sees the candidate in seeding → emits `user` status against the existing node → supersedes inferred → promoted, no duplicate.

## Error handling

- Confirm/dismiss on a non-Task or cross-user node → `TaskNotFoundError` → route maps to 404 (mirrors `setCommitmentDue`).
- Confirm a task with no active `HAS_TASK_STATUS` → `TaskNotFoundError`-style "no active status" error → 404/409; the route surfaces a structured message.
- All boundaries parse through Zod request schemas; the lib functions trust the parsed types.

## Testing strategy

DB-backed (`describeIfServer`, port 5431, `setSkipEmbeddingPersistence`) unless noted:

- **Query:** `getCandidateCommitments` returns only active personal `assistant_inferred` pending/in_progress tasks; `getOpenCommitments` still excludes them (no regression). A task with an inferred owner/due surfaces its owner/due in the candidate view.
- **Confirm:** confirming a candidate creates a `user_confirmed` superseding claim; the task leaves the candidate view and enters `getOpenCommitments`; the prior inferred claim is `superseded`.
- **Dismiss:** retracts the active status; task disappears from both views; Task node still present.
- **Lifecycle tiebreak (pinned):** `confirmCommitment` (statedAt=now) reliably wins over the inferred claim; a corroborating `user` status on realistic timestamps promotes rather than the inferred one winning.
- **Convergence:** an extraction pass seeded with a candidate, given corroborating content, emits a `user` status against the existing node id and creates **no** new Task (exercise via the `eval:ingest` probe path or a focused extractor unit test with the stubbed completion client).
- **Schema tests** (fast, no DB): confirm/dismiss request schemas.
- **Tool-description snapshots:** pin `confirm_commitment` / `dismiss_commitment` and the updated `create_commitment` description.

## Risks

- **Lifecycle tiebreak ordering.** Supersession ranks by `(statedAt, createdAt)` with trust as tiebreaker, so a _newer_ inferred claim could in principle supersede an older `user` one. Pre-existing behavior; the pinned tiebreak test guards the confirm/auto-promote paths. If it bites, escalate to making trusted kinds strictly dominate inferred regardless of recency for `HAS_TASK_STATUS` — out of scope unless the test forces it.
- **Re-nag after dismiss.** "Retract only" means a much-later re-inference can resurface a dismissed candidate. Accepted; a sticky marker is the documented follow-up if it becomes a nuisance.
- **Candidate owner/due joins.** The metadata sub-joins must apply no provenance constraint on the candidate path (not `eq(assistant_inferred)`), or a _trusted_ owner/due set on a candidate is silently dropped. Covered by the candidate-with-inferred-metadata and candidate-with-trusted-metadata tests.
