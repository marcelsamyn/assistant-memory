# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`setCommitmentStatus`** — advance a Task's lifecycle status (`pending → in_progress → done / abandoned`) in one call. The predicate lifecycle engine supersedes the prior active `HAS_TASK_STATUS` claim automatically; the response echoes `previousStatus`/`previousClaimId` for optimistic-update and one-click-undo flows. Available as `POST /commitments/status`, `MemoryClient.setCommitmentStatus`, and the `set_commitment_status` MCP tool.

- **`setCommitmentOwner`** — assign, reassign, or clear a Task's `OWNED_BY` claim. Pass a node id to assign (supersedes the prior claim) or `null` to retract all active owner claims. Available as `POST /commitments/owner`, `MemoryClient.setCommitmentOwner`, and the `set_commitment_owner` MCP tool.

- **`updateCommitment`** — rename a Task and/or edit its description. Unlike the generic node-update path (which blocks description edits on knowledge nodes), this Task-scoped operation allows updating user-authored metadata and re-embeds the node when either field changes. Available as `POST /commitments/update`, `MemoryClient.updateCommitment`, and the `update_commitment` MCP tool.

- **`listCommitments`** — paginated, sortable, searchable, filterable list across all four task statuses (open and closed). Supports status, provenance, owner, due-date range, and label-substring filters; keyset cursor pagination; and four sort keys (`statusChangedAt`, `dueOn`, `createdAt`, `label`). Available as `POST /commitments/list`, `MemoryClient.listCommitments`, and the `list_commitments` MCP tool.

- **`getCommitment`** — detailed read model for a single Task: current status, owner, and due date (with their claim ids and provenance), full lifecycle history across `HAS_TASK_STATUS`/`OWNED_BY`/`DUE_ON` claims, and the distinct evidence sources behind the task. `includeHistory` and `includeSources` flags control response size. Available as `POST /commitments/get`, `MemoryClient.getCommitment`, and the `get_commitment` MCP tool.

- **`docs/sdk/`** — initial SDK reference documentation set. `docs/sdk/README.md` covers client construction; `docs/sdk/commitments.md` is the full commitments reference (all eleven methods, request/response shapes, lifecycle semantics, and end-to-end flow examples).

[Unreleased]: https://github.com/your-org/assistant-memory/compare/v1.15.0...HEAD
