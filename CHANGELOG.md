# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`pruneStaleNodes` — deterministic, preview-then-apply memory garbage collection.** A new `POST /maintenance/prune-stale-nodes` endpoint (and `MemoryClient.pruneStaleNodes`) scores every entity/task node on a transparent, LLM-free weighted sum — `0.40·staleness + 0.25·isolation + 0.20·weakProvenance + 0.15·claimDecay` — and prunes the disposable tail: old, weakly-connected, assistant-inferred-only, or superseded-dominated nodes. Tune with a single `aggressiveness` knob (`[0, 1]`, higher prunes more) or pin an explicit `minScore`. `dryRun` defaults to `true` and returns the ranked candidates with per-node `reasons` plus the full `candidateCount`; re-call with the same thresholds and `dryRun: false` to delete (cascades through claims, source links, aliases, and embeddings). The sweep never touches nodes active within `minIdleDays`, nodes with a currently-open task status, the user's self-identity node(s), or — unless `includeReference` is set — reference-scope nodes. Complements the narrower `pruneOrphanNodes` (evidence-free nodes) and `dedupSweep` (exact-label duplicates).

### Fixed

- **Automatic merges no longer collapse distinct records that share a label.** Both auto-merge paths — the deterministic `dedupSweep` and the LLM-driven graph cleanup — now only merge nominal-entity node types (`Person`, `Location`, `Object`, `Emotion`, `Concept`, `Media`, `Temporal`) when their canonical labels match. Record/occurrence types (`Task`, `Event`, `Idea`, `Document`, `Conversation`, `AssistantDream`, `Feedback`, `Atlas`) can legitimately recur with identical names — e.g. a task created for each day of the week, or a weekly standup event — and are now left untouched. Previously the sweep fused all same-titled tasks into one node carrying every `DUE_ON` link, so completing one day's task completed them all. Explicit, user-initiated merges via `POST /node/merge` are unaffected. The classification lives in a single source of truth (`LABEL_MERGEABLE_NODE_TYPES` / `isLabelMergeableNodeType` in `types/graph`).

- **Conversation/document ingestion no longer manufactures spurious or auto-trusted tasks.** The graph-extraction prompt now explicitly forbids minting Task nodes from assistant suggestions, recaps/summaries, uncommitted planning, or the existence of the conversation itself (e.g. a "weekly check-in" task), and requires Task labels to be short imperative actions rather than conversation summaries. Additionally, **every brand-new task created during ingestion is now recorded as tentative (the candidate band) deterministically** — the model no longer decides this, so a passive background ingest can never fabricate a firm commitment. Firm commitments arise only from explicit user action: the candidate-confirmation flow (a later status claim against the existing task) or the commitment write APIs.

## [1.17.0] — 2026-06-07

### Added

- **Due time + timezone on commitments** — `createCommitment` and `setCommitmentDue` now accept optional `dueTime` (`HH:mm`, 24h) and `timeZone` (IANA name) fields to qualify a due date with wall-clock precision. The two fields are mutually required and require a `dueOn` date. The resolved UTC instant is stored in a new indexed `claims.object_instant` column and surfaced as `dueAt` (`Date | null`) on all commitment read models (`createCommitment`, `setCommitmentDue`, `getOpenCommitments`, `listCommitments`, `getCommitment`). Date-only commitments are unchanged; all new fields are nullable and backward-compatible.

- **`listCommitments` instant filters** — new `dueBeforeInstant` / `dueAfterInstant` request fields filter by the resolved UTC instant (`object_instant`). These match timed tasks only; date-only tasks have no instant and are excluded when either filter is active.

- **`listCommitments` `dueAt` sort key** — `sort: "dueAt"` orders by the resolved UTC instant, with date-only and undated tasks sorted last (same nulls-last semantics as `sort: "dueOn"`).

- **Digest intraday-overdue bucketing** — the daily digest now compares timed tasks by their resolved UTC instant against the current wall-clock time in the caller's timezone. A timed task flips from _due today_ to _overdue_ as soon as its instant passes, without waiting for the calendar day to change. Date-only tasks continue to use calendar-day string comparison.

## [1.16.0] — 2026-06-06

### Added

- **`setCommitmentStatus`** — advance a Task's lifecycle status (`pending → in_progress → done / abandoned`) in one call. The predicate lifecycle engine supersedes the prior active `HAS_TASK_STATUS` claim automatically; the response echoes `previousStatus`/`previousClaimId` for optimistic-update and one-click-undo flows. Available as `POST /commitments/status`, `MemoryClient.setCommitmentStatus`, and the `set_commitment_status` MCP tool.

- **`setCommitmentOwner`** — assign, reassign, or clear a Task's `OWNED_BY` claim. Pass a node id to assign (supersedes the prior claim) or `null` to retract all active owner claims. Available as `POST /commitments/owner`, `MemoryClient.setCommitmentOwner`, and the `set_commitment_owner` MCP tool.

- **`updateCommitment`** — rename a Task and/or edit its description. Unlike the generic node-update path (which blocks description edits on knowledge nodes), this Task-scoped operation allows updating user-authored metadata and re-embeds the node when either field changes. Available as `POST /commitments/update`, `MemoryClient.updateCommitment`, and the `update_commitment` MCP tool.

- **`listCommitments`** — paginated, sortable, searchable, filterable list across all four task statuses (open and closed). Supports status, provenance, owner, due-date range, and label-substring filters; keyset cursor pagination; and four sort keys (`statusChangedAt`, `dueOn`, `createdAt`, `label`). Available as `POST /commitments/list`, `MemoryClient.listCommitments`, and the `list_commitments` MCP tool.

- **`getCommitment`** — detailed read model for a single Task: current status, owner, and due date (with their claim ids and provenance), full lifecycle history across `HAS_TASK_STATUS`/`OWNED_BY`/`DUE_ON` claims, and the distinct evidence sources behind the task. `includeHistory` and `includeSources` flags control response size. Available as `POST /commitments/get`, `MemoryClient.getCommitment`, and the `get_commitment` MCP tool.

- **`docs/sdk/`** — initial SDK reference documentation set. `docs/sdk/README.md` covers client construction; `docs/sdk/commitments.md` is the full commitments reference (all eleven methods, request/response shapes, lifecycle semantics, and end-to-end flow examples).

[Unreleased]: https://github.com/your-org/assistant-memory/compare/v1.17.0...HEAD
[1.17.0]: https://github.com/your-org/assistant-memory/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/your-org/assistant-memory/compare/v1.15.0...v1.16.0
