# Commitment Manager SDK/API — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)
**Author:** Memory team

## Goal

Make the Memory SDK/API a complete backend for **Petals as a full task/commitment
manager**. Today a host can open commitments (`createCommitment`), set due dates
(`setCommitmentDue`), confirm/dismiss candidates, and read the open/candidate
views — but the moment the user wants to *change status*, *reassign an owner*,
*rename a task*, *see finished work*, or *browse/search/paginate* tasks, the host
has to hand-roll generic `createClaim`/`updateNode`/`createClaim` calls and learn
the predicate/lifecycle internals. This design closes those gaps with five
first-class operations that wrap the existing claim-lifecycle engine.

## Non-goals (YAGNI)

- No new task statuses; the lifecycle stays `pending | in_progress | done | abandoned`.
- No due **time** — `DUE_ON` is date-only, and we keep it that way.
- No subtasks, tags, priorities, recurring tasks, or assignees-beyond-`OWNED_BY`.
- No new candidate-review operations — `getCandidateCommitments` / `confirmCommitment`
  / `dismissCommitment` already cover approve/reject and are sufficient. They are
  **documented** here but not changed.
- No trigram/`pg_trgm` search index — personal scale makes `ILIKE` substring search
  fine. Noted as a future option only.

## Background: what already exists (unchanged, documented)

From `src/lib/commitments.ts`, `src/lib/query/open-commitments.ts`, and the
predicate registry (`src/lib/claims/predicate-policies.ts`):

- **Task model:** a `Task` node carries its state entirely through claims:
  - `HAS_TASK_STATUS` (objectValue ∈ `TaskStatusEnum`) — `single_current_value` +
    `supersede_previous`. Exactly one active status per task.
  - `OWNED_BY` (objectNodeId → owner node) — `multi_value` globally, but
    `single_current_value` + `supersede_previous` **on Task subjects**.
  - `DUE_ON` (objectNodeId → Temporal/day node) — same Task-subject override.
- **Lifecycle engine** (`src/lib/claims/lifecycle.ts`): creating a new claim for a
  superseding predicate automatically marks the prior active claim `superseded` and
  links `supersededByClaimId`. A `user`/`user_confirmed` claim is never silently
  overwritten by a later `assistant_inferred` one (trust rule).
- **Existing surface:** `createCommitment`, `setCommitmentDue`, `getOpenCommitments`,
  `getCandidateCommitments`, `confirmCommitment`, `dismissCommitment` — each with a
  route under `src/routes/commitments/`, a `MemoryClient` method, and (most) an MCP
  tool.

The five new operations slot into exactly these patterns.

## The five new operations

All requests carry `userId: z.string()` (the per-user isolation key, consistent
with every other route/tool). All new schemas live in `src/lib/schemas/`, are
exported from `src/sdk/index.ts`, get a `MemoryClient` method, and an MCP tool.
Routes are file-based Nitro handlers under `src/routes/commitments/`.

### 1. `setCommitmentStatus` — mark done / abandoned / pending / in_progress

- **Route:** `POST /commitments/status`
- **Lib:** `setCommitmentStatus` in `src/lib/commitments.ts`
- **Schema:** `src/lib/schemas/set-commitment-status.ts`

```ts
setCommitmentStatusRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  status: TaskStatusEnum,                 // all four values allowed
  note: z.string().min(1).optional(),     // stored on the claim.description
  assertedByKind: AssertedByKindEnum.optional(),  // defaults to "user"
});

setCommitmentStatusResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  status: TaskStatusEnum,
  claimId: typeIdSchema("claim"),
  previousStatus: TaskStatusEnum.nullable(),
  previousClaimId: typeIdSchema("claim").nullable(),
});
```

**Behavior:** `requireOwnedTask` → read the current active `HAS_TASK_STATUS`
(single cheap select, ordered `statedAt desc, createdAt desc`, like
`confirmCommitment`) to capture `previousStatus`/`previousClaimId` → `createClaim`
a new `HAS_TASK_STATUS` with the new value (statement auto-built, e.g.
`"<label> is done."`). The lifecycle engine supersedes the prior status. The
`previous*` fields give Petals a clean optimistic-update / one-click-undo signal.
Idempotent on value: re-asserting the same status is allowed (records a fresh
claim) — we do not special-case "already in that status".

**Why not just `createClaim`:** the caller never has to know the predicate name,
build a statement, or know that `done`/`abandoned` are reachable only via
supersession (not at creation). This is the headline ergonomic win.

### 2. `setCommitmentOwner` — assign / reassign / clear

- **Route:** `POST /commitments/owner`
- **Lib:** `setCommitmentOwner` in `src/lib/commitments.ts`
- **Schema:** `src/lib/schemas/set-commitment-owner.ts`

A structural twin of `setCommitmentDue`.

```ts
setCommitmentOwnerRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  ownedBy: typeIdSchema("node").nullable(),  // null clears
  note: z.string().min(1).optional(),
  assertedByKind: AssertedByKindEnum.optional(),
});

setCommitmentOwnerResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  owner: z.object({ nodeId: typeIdSchema("node"), label: z.string().nullable() }).nullable(),
  claimId: typeIdSchema("claim").nullable(),
  retractedClaimIds: z.array(typeIdSchema("claim")),
});
```

**Behavior:** `requireOwnedTask`. If `ownedBy === null`: retract every active
`OWNED_BY` claim, return `owner: null, claimId: null, retractedClaimIds`. Else:
resolve the owner node's label (throw `NodesNotFoundError` if missing/cross-user),
`createClaim` an `OWNED_BY` (lifecycle supersedes prior), return the new owner +
`claimId` with empty `retractedClaimIds`.

### 3. `updateCommitment` — rename / edit description

- **Route:** `POST /commitments/update`
- **Lib:** `updateCommitment` in `src/lib/commitments.ts`
- **Schema:** `src/lib/schemas/update-commitment.ts`

```ts
updateCommitmentRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  label: z.string().min(1).optional(),
  description: z.string().optional(),       // "" clears the description
}).refine(v => v.label !== undefined || v.description !== undefined,
  { message: "Provide at least one of label or description" });

updateCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  description: z.string().nullable(),
});
```

**Behavior:** `requireOwnedTask` → reuse the node-metadata update path.

The generic `POST /node/update` route deliberately **405s on `description`**
("descriptions are generated from sourced claims") — that guard stays untouched
for knowledge nodes. But a Task's description is *user-authored* (passed straight
to `nodeMetadata.description` by `createCommitment`), so editing it is correct and
safe **for Tasks**.

Implementation: extend the existing `updateNode` lib (`src/lib/node.ts`) to accept
an optional `description`, and re-generate the node embedding when **label or
description** changes (the embed text is already `${label}: ${description}`).
`updateCommitment` calls `requireOwnedTask` then `updateNode(userId, taskId,
{ label, description })`. The 405 stays enforced at the `/node/update` *route*
(`hasNodeDescriptionUpdate` guard), so only this Task-scoped path can write a
description.

### 4. `listCommitments` — paginated, sortable, searchable, filterable

Covers "list completed/abandoned/all tasks" + "pagination, sorting, search,
dueAfter, status filters, no-due-date".

- **Route:** `POST /commitments/list`
- **Lib:** `listCommitments` in `src/lib/query/commitments-list.ts`
  (sibling to `open-commitments.ts`, reusing its 6-table join shape)
- **Schema:** `src/lib/schemas/list-commitments.ts`

`dateOnly` below is the existing inline `z.string().regex(/^\d{4}-\d{2}-\d{2}$/,
"...")` pattern used by `open-commitments.ts` / `set-commitment-due.ts`.

```ts
commitmentSortEnum = z.enum(["statusChangedAt", "dueOn", "createdAt", "label"]);
commitmentProvenanceEnum = z.enum(["trusted", "candidate", "all"]);

listCommitmentsRequestSchema = z.object({
  userId: z.string(),
  statuses: z.array(TaskStatusEnum).optional(),    // omit = all four
  provenance: commitmentProvenanceEnum.default("trusted"),
  ownedBy: typeIdSchema("node").optional(),        // tasks owned by this node
  unowned: z.boolean().optional(),                 // tasks with no active OWNED_BY
  dueBefore: dateOnly.optional(),                  // YYYY-MM-DD, inclusive
  dueAfter: dateOnly.optional(),                   // YYYY-MM-DD, inclusive
  hasDueDate: z.boolean().optional(),              // false = "no due date" only
  search: z.string().min(1).optional(),            // case-insensitive label substring
  sort: commitmentSortEnum.default("statusChangedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
}).refine(v => !(v.ownedBy !== undefined && v.unowned === true),
  { message: "ownedBy and unowned are mutually exclusive" });

commitmentListItemSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  status: TaskStatusEnum,                           // all four (not just open)
  owner: z.object({ nodeId: typeIdSchema("node"), label: z.string().nullable() }).nullable(),
  dueOn: z.string().nullable(),
  statusChangedAt: z.coerce.date(),                 // statedAt of the active status claim
  createdAt: z.coerce.date(),
  sourceId: typeIdSchema("source"),
});

listCommitmentsResponseSchema = z.object({
  commitments: z.array(commitmentListItemSchema),
  nextCursor: z.string().nullable(),
});
```

**Query & speed:**
- One round-trip, same join shape as `open-commitments.ts`: drive off the active
  `HAS_TASK_STATUS` claim (`scope = "personal"`, status `active`), inner-join the
  `Task` node + label metadata, left-join `OWNED_BY`/`DUE_ON` claims + their
  metadata. Because `HAS_TASK_STATUS` is single-active per task, there is exactly
  one row per task — **no app-side dedup needed for pagination correctness**.
- **Provenance:** `trusted` → `assertedByKind != assistant_inferred`; `candidate`
  → `= assistant_inferred`; `all` → no constraint (reuse/generalize the existing
  `provenanceFilter` helper).
- **Filters in SQL:** `statuses` → `inArray(objectValue, statuses)`; `ownedBy` →
  `eq(ownerClaim.objectNodeId, ownedBy)`; `unowned` → `isNull(ownerClaim.id)`;
  `dueBefore`/`dueAfter` → lexical compare on `dueMetadata.label` (YYYY-MM-DD sorts
  correctly as text); `hasDueDate` → `dueMetadata.label IS [NOT] NULL`; `search` →
  `ILIKE '%term%'` on the label (escape `%`/`_`).
- **Keyset pagination:** opaque base64url cursor `{ v: sortValue, i: taskId }`,
  exactly like `src/lib/sources-read.ts`. `ORDER BY <sortKey> <order>, taskId
  <order>`, `LIMIT limit + 1`, derive `nextCursor` from the last row when overflow.
  Sort keys: `statusChangedAt` → `claims.statedAt`; `createdAt` → `nodes.createdAt`;
  `label` → `nodeMetadata.label`; `dueOn` → `dueMetadata.label`.
- **Null handling for `dueOn` sort:** undated tasks always sort **last** regardless
  of `order`. Implement with a leading `dueMetadata.label IS NULL` ordering term
  (nulls last) and encode the null-boundary flag in the cursor so the keyset stays
  total. The default sort (`statusChangedAt`) has no nulls — every listed task has
  an active status claim — so the common path is a clean single keyset.

**Default sort:** `statusChangedAt desc` (most recently touched first) — sensible
across a mixed open + done + abandoned list.

### 5. `getCommitment` — detail read model

- **Route:** `POST /commitments/get`
- **Lib:** `getCommitment` in `src/lib/query/commitment-detail.ts`
- **Schema:** `src/lib/schemas/get-commitment.ts`

```ts
getCommitmentRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  includeHistory: z.boolean().default(true),
  includeSources: z.boolean().default(true),
});

taskLifecycleEntrySchema = z.object({
  claimId: typeIdSchema("claim"),
  predicate: z.enum(["HAS_TASK_STATUS", "OWNED_BY", "DUE_ON"]),
  value: z.string().nullable(),            // objectValue (status) or objectLabel (owner/due)
  objectNodeId: typeIdSchema("node").nullable(),
  status: ClaimStatusEnum,                 // active | superseded | retracted | contradicted
  assertedByKind: AssertedByKindEnum,
  sourceId: typeIdSchema("source"),
  statedAt: z.coerce.date(),
});
// NOTE: no supersededByClaimId — getNodeById (reused for the single-query history
// slice) doesn't surface it, and status + statedAt-desc ordering already convey
// the supersession chain. Not worth a second query.

// Evidence source shape — deliberately NOT sourceSummarySchema, whose `type` is
// the listable enum that EXCLUDES "manual". User-created tasks carry a `manual`
// source, so reusing that schema would drop their evidence. `type` is a plain
// string here to admit every source type.
commitmentSourceSchema = z.object({
  sourceId: typeIdSchema("source"),
  type: z.string(),
  title: z.string().nullable(),
  scope: ScopeEnum,
  ingestedAt: z.coerce.date(),             // lastIngestedAt ?? createdAt
});

getCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.coerce.date(),
  status: TaskStatusEnum.nullable(),       // null if no active status (e.g. dismissed)
  statusClaimId: typeIdSchema("claim").nullable(),
  statusStatedAt: z.coerce.date().nullable(),
  statusAssertedByKind: AssertedByKindEnum.nullable(),
  owner: z.object({
    nodeId: typeIdSchema("node"),
    label: z.string().nullable(),
    claimId: typeIdSchema("claim"),
  }).nullable(),
  dueOn: z.string().nullable(),
  dueClaimId: typeIdSchema("claim").nullable(),
  sources: z.array(commitmentSourceSchema),   // evidence; empty when includeSources=false
  history: z.array(taskLifecycleEntrySchema),  // empty when includeHistory=false
});
```

**Behavior & speed:** Reuse `getNodeById(userId, taskId, { predicates:
["HAS_TASK_STATUS","OWNED_BY","DUE_ON"], statuses: [] })` — one query returns the
node (label/description/createdAt) plus the **full lifecycle slice** (all statuses,
including superseded/retracted) of exactly the three task predicates. Derive the
current `status`/`owner`/`dueOn` from the `active` claims (filtering claims to
`subjectNodeId === taskId`), and (when `includeHistory`) map the rest into
`history` sorted `statedAt desc`. When `includeSources`, collect the distinct
`sourceId`s from those claims and resolve them in **one batched `inArray` query**
over `sources` (no listable-type filter, so `manual` sources surface; no N+1).
Non-Task or cross-user `taskId` → `TaskNotFoundError` → 404.

## Cross-cutting

- **Errors:** reuse `TaskNotFoundError` (→ 404) and `NodesNotFoundError`, with the
  existing route `try/catch` → `createError({ statusCode })` pattern used by
  `create.post.ts` / `due.post.ts`.
- **MCP tools** (`src/lib/mcp/mcp-server.ts`): `set_commitment_status`,
  `set_commitment_owner`, `update_commitment`, `list_commitments`,
  `get_commitment`. Each registers `schema.shape`, delegates to the same lib
  function as the route, returns `{ content: [{ type: "text", text:
  JSON.stringify(responseSchema.parse(result), null, 2) }] }`, and maps known
  errors to `{ isError: true }`. Each gets a description constant in
  `src/lib/mcp/tool-descriptions.ts` (pinned by `tool-descriptions.test.ts`).
- **SDK:** five `MemoryClient` methods (thin `_fetch` wrappers, with TSDoc), and
  five `export * from "../lib/schemas/..."` lines in `src/sdk/index.ts`.
- **`MemoryClient` ergonomics:** TSDoc on each method explaining the lifecycle
  effect (supersession, retraction) so SDK consumers don't need to read this spec.

## Testing

Follow existing colocated Vitest patterns (real DB on the test port; only external
services mocked):

- `src/lib/commitments.test.ts` (extend): `setCommitmentStatus` supersedes prior
  status + returns `previous*`; all four status values; `setCommitmentOwner`
  assign/reassign/clear + `NodesNotFoundError`; `updateCommitment` label-only,
  description-only, both, re-embed, non-Task → `TaskNotFoundError`.
- `src/lib/query/commitments-list.test.ts`: status filter, provenance bands,
  `ownedBy`/`unowned`, `dueBefore`/`dueAfter`/`hasDueDate`, `search`, each sort +
  order, **keyset pagination roundtrip** (no dupes/gaps across pages), `dueOn`
  null-ordering.
- `src/lib/query/commitment-detail.test.ts`: current-state derivation, history
  ordering incl. superseded/retracted, `sources` dedup, `includeHistory`/
  `includeSources=false`, non-Task → 404.
- Route smoke tests where the existing suite has them; MCP description snapshot
  update.

## Documentation & changelog

- **`docs/sdk/README.md`** — index of the SDK reference set (one paragraph per
  domain + links), starting with Commitments.
- **`docs/sdk/commitments.md`** — full reference for the **entire** commitment
  surface: the existing `createCommitment` / `setCommitmentDue` /
  `getOpenCommitments` / `getCandidateCommitments` / `confirmCommitment` /
  `dismissCommitment`, **plus** the five new operations. Each entry: purpose,
  request/response shape, lifecycle effect, and a short example. A "Typical flows"
  section (open → progress → done; review candidates; reassign; browse history).
- **`CHANGELOG.md`** (repo root, Keep-a-Changelog format) — new `Added` entries
  under the next version for the five operations + the docs set.

## Build/verify gates

`pnpm run build:check` (tsc + structured-output schema check), `pnpm run test`,
`pnpm run lint`, `pnpm run format`. New response schemas that are *not* used as
OpenAI structured outputs are unaffected by the structured-output checker, but we
run it to be safe.
