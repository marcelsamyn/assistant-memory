# Commitments

Commitments are **Task nodes** in the memory graph. A Task's state lives entirely in claims attached to it:

- `HAS_TASK_STATUS` — the task's current lifecycle position: `pending`, `in_progress`, `done`, or `abandoned`. Exactly one active status claim exists per task at any time; creating a new one automatically supersedes the prior.
- `OWNED_BY` — points to an owner node (typically a `Person`). Enforced as single-active on Task subjects; reassigning creates a new claim and supersedes the prior.
- `DUE_ON` — points to a Temporal day node. Same single-active rule; the server resolves the canonical day node from the `YYYY-MM-DD` string.

The **lifecycle engine** (`single_current_value + supersede_previous` predicate policy) maintains these invariants automatically — callers never manually supersede or retract prior claims when using commitment methods.

**Candidate tasks** are tasks whose `HAS_TASK_STATUS` was asserted as `assistant_inferred`. They appear in `getCandidateCommitments` but not in `getOpenCommitments` until confirmed. Trust rule: a `user`/`user_confirmed` claim is never silently overwritten by a later `assistant_inferred` one.

---

## Creating and editing

### `createCommitment`

Opens a new Task node, bootstrapping it with a `HAS_TASK_STATUS` claim and optionally `DUE_ON` and `OWNED_BY` claims in a single round-trip.

**Route:** `POST /commitments/create`

**Request**

| Field            | Type                         | Required | Notes                                                                                                                       |
| ---------------- | ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `userId`         | `string`                     | yes      | Per-user isolation key.                                                                                                     |
| `label`          | `string` (min 1)             | yes      | Human-readable task name.                                                                                                   |
| `description`    | `string` (min 1)             | no       | Optional longer description.                                                                                                |
| `status`         | `"pending" \| "in_progress"` | no       | Defaults to `"pending"`. Only open statuses are allowed at creation; use `setCommitmentStatus` to reach `done`/`abandoned`. |
| `dueOn`          | `string` (`YYYY-MM-DD`)      | no       | Server resolves/creates the Temporal day node.                                                                              |
| `ownedBy`        | `nodeId`                     | no       | Must be an existing node owned by `userId`.                                                                                 |
| `assertedByKind` | `AssertedByKind`             | no       | Defaults to `"user"`.                                                                                                       |

**Response**

| Field           | Type                         | Notes                                     |
| --------------- | ---------------------------- | ----------------------------------------- |
| `taskId`        | `nodeId`                     | The new Task node id.                     |
| `label`         | `string`                     | As stored.                                |
| `status`        | `"pending" \| "in_progress"` |                                           |
| `dueOn`         | `string \| null`             |                                           |
| `owner`         | `{ nodeId, label } \| null`  |                                           |
| `statusClaimId` | `claimId`                    | The bootstrapped `HAS_TASK_STATUS` claim. |
| `dueClaimId`    | `claimId \| null`            |                                           |
| `ownerClaimId`  | `claimId \| null`            |                                           |

**Lifecycle effect:** creates a fresh Task node; always starts in an open status. Does not deduplicate against existing tasks with the same label.

```ts
const task = await client.createCommitment({
  userId: "user_abc",
  label: "Finalise Q3 report",
  dueOn: "2026-07-31",
  status: "in_progress",
});
// task.taskId, task.statusClaimId are available immediately
```

---

### `updateCommitment`

Rename a Task and/or edit its description. At least one of `label`/`description` must be provided. Passing `description: ""` clears it.

**Route:** `POST /commitments/update`

**Request**

| Field         | Type             | Required | Notes                             |
| ------------- | ---------------- | -------- | --------------------------------- |
| `userId`      | `string`         | yes      |                                   |
| `taskId`      | `nodeId`         | yes      | Must be a Task owned by `userId`. |
| `label`       | `string` (min 1) | one of   | New label.                        |
| `description` | `string`         | one of   | New description; `""` clears it.  |

**Response**

| Field         | Type             | Notes |
| ------------- | ---------------- | ----- |
| `taskId`      | `nodeId`         |       |
| `label`       | `string \| null` |       |
| `description` | `string \| null` |       |

**Lifecycle effect:** mutates node metadata and re-embeds the node (used for similarity search). Unlike generic `POST /node/update`, this path allows editing `description` — because a Task's description is user-authored, not claim-derived.

```ts
await client.updateCommitment({
  userId: "user_abc",
  taskId: "node_01kq...",
  label: "Finalise Q3 board report",
});
```

---

## Status

### `setCommitmentStatus`

Advance (or change) a Task's lifecycle status. All four status values are reachable; `done` and `abandoned` are only reachable through this superseding path, not at creation.

**Route:** `POST /commitments/status`

**Request**

| Field            | Type                                                  | Required | Notes                                    |
| ---------------- | ----------------------------------------------------- | -------- | ---------------------------------------- |
| `userId`         | `string`                                              | yes      |                                          |
| `taskId`         | `nodeId`                                              | yes      | Must be a Task owned by `userId`.        |
| `status`         | `"pending" \| "in_progress" \| "done" \| "abandoned"` | yes      | Target status.                           |
| `note`           | `string` (min 1)                                      | no       | Stored as the new claim's `description`. |
| `assertedByKind` | `AssertedByKind`                                      | no       | Defaults to `"user"`.                    |

**Response**

| Field             | Type                 | Notes                                          |
| ----------------- | -------------------- | ---------------------------------------------- |
| `taskId`          | `nodeId`             |                                                |
| `status`          | `TaskStatus`         | The new active status.                         |
| `claimId`         | `claimId`            | The newly asserted `HAS_TASK_STATUS` claim.    |
| `previousStatus`  | `TaskStatus \| null` | The status just superseded, or `null` if none. |
| `previousClaimId` | `claimId \| null`    | The superseded claim's id, for undo flows.     |

**Lifecycle effect:** creates a new `HAS_TASK_STATUS` claim; the lifecycle engine supersedes the prior active one. Re-asserting the same status is allowed (records a fresh claim). The `previous*` fields enable optimistic-update and one-click-undo without a second read.

```ts
// Mark a task done
const result = await client.setCommitmentStatus({
  userId: "user_abc",
  taskId: "node_01kq...",
  status: "done",
  note: "Submitted to board portal",
});
// result.previousStatus === "in_progress"
```

---

## Owner

### `setCommitmentOwner`

Assign, reassign, or clear a Task's owner. A structural twin of `setCommitmentDue`.

**Route:** `POST /commitments/owner`

**Request**

| Field            | Type             | Required | Notes                                                      |
| ---------------- | ---------------- | -------- | ---------------------------------------------------------- |
| `userId`         | `string`         | yes      |                                                            |
| `taskId`         | `nodeId`         | yes      |                                                            |
| `ownedBy`        | `nodeId \| null` | yes      | Node id to assign, or `null` to clear.                     |
| `note`           | `string` (min 1) | no       | Stored on the new claim. Ignored when `ownedBy` is `null`. |
| `assertedByKind` | `AssertedByKind` | no       | Defaults to `"user"`. Ignored when `ownedBy` is `null`.    |

**Response**

| Field               | Type                        | Notes                                                                                                                                  |
| ------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`            | `nodeId`                    |                                                                                                                                        |
| `owner`             | `{ nodeId, label } \| null` | The new owner, or `null` after a clear.                                                                                                |
| `claimId`           | `claimId \| null`           | The new `OWNED_BY` claim. `null` on the clear path.                                                                                    |
| `retractedClaimIds` | `claimId[]`                 | Prior claims retracted. Populated only on the clear path (`ownedBy: null`); empty when assigning (lifecycle supersedes automatically). |

**Lifecycle effect:** assign path — creates a new `OWNED_BY` claim; lifecycle supersedes the prior. Clear path — retracts every active `OWNED_BY` claim; no new claim asserted. `NodesNotFoundError` (404) if the owner node does not exist or belongs to a different user.

```ts
// Assign
await client.setCommitmentOwner({
  userId: "user_abc",
  taskId: "node_01kq...",
  ownedBy: "node_01person...",
});

// Clear
await client.setCommitmentOwner({
  userId: "user_abc",
  taskId: "node_01kq...",
  ownedBy: null,
});
```

---

## Due date

### `setCommitmentDue`

Set or clear a Task's due date. The server resolves the canonical Temporal day node internally — callers pass a plain `YYYY-MM-DD` string.

**Route:** `POST /commitments/due`

**Request**

| Field            | Type             | Required | Notes                                               |
| ---------------- | ---------------- | -------- | --------------------------------------------------- |
| `userId`         | `string`         | yes      |                                                     |
| `taskId`         | `nodeId`         | yes      |                                                     |
| `dueOn`          | `string \| null` | yes      | `YYYY-MM-DD` to set, `null` to clear.               |
| `note`           | `string` (min 1) | no       | Stored on the new `DUE_ON` claim. Ignored on clear. |
| `assertedByKind` | `AssertedByKind` | no       | Defaults to `"user"`. Ignored on clear.             |

**Response**

| Field               | Type              | Notes                                                              |
| ------------------- | ----------------- | ------------------------------------------------------------------ |
| `taskId`            | `nodeId`          |                                                                    |
| `dueOn`             | `string \| null`  | The new date, or `null` after a clear.                             |
| `claimId`           | `claimId \| null` | The new `DUE_ON` claim. `null` on the clear path.                  |
| `retractedClaimIds` | `claimId[]`       | Prior `DUE_ON` claims retracted. Populated only on the clear path. |

**Lifecycle effect:** identical pattern to `setCommitmentOwner`. Set path supersedes via lifecycle; clear path retracts explicitly.

```ts
await client.setCommitmentDue({
  userId: "user_abc",
  taskId: "node_01kq...",
  dueOn: "2026-08-15",
});
```

---

## Reading and listing

### `getOpenCommitments`

Returns only Task nodes whose latest **trusted** personal `HAS_TASK_STATUS` is `pending` or `in_progress`. Candidate (assistant-inferred) tasks are excluded.

**Route:** `POST /commitments/open`

**Request**

| Field       | Type                    | Required | Notes                                                   |
| ----------- | ----------------------- | -------- | ------------------------------------------------------- |
| `userId`    | `string`                | yes      |                                                         |
| `ownedBy`   | `nodeId`                | no       | Filter to tasks owned by this node.                     |
| `dueBefore` | `string` (`YYYY-MM-DD`) | no       | Inclusive upper bound; undated tasks excluded when set. |

**Response:** `{ commitments: OpenCommitment[] }`

Each `OpenCommitment`:

| Field      | Type                         |
| ---------- | ---------------------------- |
| `taskId`   | `nodeId`                     |
| `label`    | `string \| null`             |
| `status`   | `"pending" \| "in_progress"` |
| `owner`    | `{ nodeId, label } \| null`  |
| `dueOn`    | `string \| null`             |
| `statedAt` | `Date`                       |
| `sourceId` | `sourceId`                   |

```ts
const { commitments } = await client.getOpenCommitments({
  userId: "user_abc",
  dueBefore: "2026-07-01",
});
```

---

### `listCommitments`

Paginated, sortable, searchable list across **all four statuses** (open, done, abandoned). Drives off the active `HAS_TASK_STATUS` claim — exactly one row per task, no dedup needed.

**Route:** `POST /commitments/list`

**Request**

| Field        | Type                                                     | Required | Default             | Notes                                                                                  |
| ------------ | -------------------------------------------------------- | -------- | ------------------- | -------------------------------------------------------------------------------------- |
| `userId`     | `string`                                                 | yes      |                     |                                                                                        |
| `statuses`   | `TaskStatus[]`                                           | no       | all four            | Filter to specific statuses.                                                           |
| `provenance` | `"trusted" \| "candidate" \| "all"`                      | no       | `"trusted"`         | `"trusted"` excludes `assistant_inferred`; `"candidate"` is only `assistant_inferred`. |
| `ownedBy`    | `nodeId`                                                 | no       |                     | Mutually exclusive with `unowned`.                                                     |
| `unowned`    | `boolean`                                                | no       |                     | Only tasks with no active `OWNED_BY`.                                                  |
| `dueBefore`  | `string` (`YYYY-MM-DD`)                                  | no       |                     | Inclusive upper bound on due date.                                                     |
| `dueAfter`   | `string` (`YYYY-MM-DD`)                                  | no       |                     | Inclusive lower bound on due date.                                                     |
| `hasDueDate` | `boolean`                                                | no       |                     | `false` = undated tasks only; `true` = dated tasks only.                               |
| `search`     | `string` (min 1)                                         | no       |                     | Case-insensitive label substring match.                                                |
| `sort`       | `"statusChangedAt" \| "dueOn" \| "createdAt" \| "label"` | no       | `"statusChangedAt"` |                                                                                        |
| `order`      | `"asc" \| "desc"`                                        | no       | `"desc"`            |                                                                                        |
| `limit`      | `number` (1–200)                                         | no       | `50`                |                                                                                        |
| `cursor`     | `string`                                                 | no       |                     | Opaque keyset cursor from a prior page's `nextCursor`.                                 |

`ownedBy` and `unowned` are mutually exclusive; passing both returns a validation error.

Undated tasks always sort **last** when `sort: "dueOn"`, regardless of `order`.

**Response:** `{ commitments: CommitmentListItem[], nextCursor: string | null }`

Each `CommitmentListItem`:

| Field             | Type                        | Notes                                  |
| ----------------- | --------------------------- | -------------------------------------- |
| `taskId`          | `nodeId`                    |                                        |
| `label`           | `string \| null`            |                                        |
| `status`          | `TaskStatus`                | Any of the four.                       |
| `owner`           | `{ nodeId, label } \| null` |                                        |
| `dueOn`           | `string \| null`            |                                        |
| `statusChangedAt` | `Date`                      | `statedAt` of the active status claim. |
| `createdAt`       | `Date`                      |                                        |
| `sourceId`        | `sourceId`                  |                                        |

```ts
// First page of done tasks, newest first
const page1 = await client.listCommitments({
  userId: "user_abc",
  statuses: ["done"],
  sort: "statusChangedAt",
  order: "desc",
  limit: 20,
});

// Next page
if (page1.nextCursor) {
  const page2 = await client.listCommitments({
    userId: "user_abc",
    statuses: ["done"],
    sort: "statusChangedAt",
    order: "desc",
    limit: 20,
    cursor: page1.nextCursor,
  });
}
```

---

### `getCommitment`

Detailed read model for a single Task: current state (status, owner, due date) plus full lifecycle history and evidence sources.

**Route:** `POST /commitments/get`

**Request**

| Field            | Type      | Required | Default | Notes                                                                             |
| ---------------- | --------- | -------- | ------- | --------------------------------------------------------------------------------- |
| `userId`         | `string`  | yes      |         |                                                                                   |
| `taskId`         | `nodeId`  | yes      |         |                                                                                   |
| `includeHistory` | `boolean` | no       | `true`  | Include full lifecycle history of `HAS_TASK_STATUS`, `OWNED_BY`, `DUE_ON` claims. |
| `includeSources` | `boolean` | no       | `true`  | Include distinct evidence sources behind the task's claims.                       |

**Response**

| Field                  | Type                                 | Notes                                                                 |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| `taskId`               | `nodeId`                             |                                                                       |
| `label`                | `string \| null`                     |                                                                       |
| `description`          | `string \| null`                     |                                                                       |
| `createdAt`            | `Date`                               |                                                                       |
| `status`               | `TaskStatus \| null`                 | Active status value; `null` if no active status (e.g. after dismiss). |
| `statusClaimId`        | `claimId \| null`                    |                                                                       |
| `statusStatedAt`       | `Date \| null`                       |                                                                       |
| `statusAssertedByKind` | `AssertedByKind \| null`             |                                                                       |
| `owner`                | `{ nodeId, label, claimId } \| null` | Includes the active `OWNED_BY` claim id.                              |
| `dueOn`                | `string \| null`                     |                                                                       |
| `dueClaimId`           | `claimId \| null`                    |                                                                       |
| `sources`              | `CommitmentSource[]`                 | Empty when `includeSources: false`.                                   |
| `history`              | `TaskLifecycleEntry[]`               | Sorted `statedAt` desc; empty when `includeHistory: false`.           |

Each `CommitmentSource`:

| Field        | Type                        | Notes                                                      |
| ------------ | --------------------------- | ---------------------------------------------------------- |
| `sourceId`   | `sourceId`                  |                                                            |
| `type`       | `string`                    | Any source type including `"manual"` (user-created tasks). |
| `title`      | `string \| null`            |                                                            |
| `scope`      | `"personal" \| "reference"` |                                                            |
| `ingestedAt` | `Date`                      | `lastIngestedAt` falling back to `createdAt`.              |

Each `TaskLifecycleEntry`:

| Field            | Type                                                        | Notes                                                  |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| `claimId`        | `claimId`                                                   |                                                        |
| `predicate`      | `"HAS_TASK_STATUS" \| "OWNED_BY" \| "DUE_ON"`               |                                                        |
| `value`          | `string \| null`                                            | `objectValue` for status; `objectLabel` for owner/due. |
| `objectNodeId`   | `nodeId \| null`                                            |                                                        |
| `status`         | `"active" \| "superseded" \| "retracted" \| "contradicted"` |                                                        |
| `assertedByKind` | `AssertedByKind`                                            |                                                        |
| `sourceId`       | `sourceId`                                                  |                                                        |
| `statedAt`       | `Date`                                                      |                                                        |

Non-Task or cross-user `taskId` returns a 404 error.

```ts
const detail = await client.getCommitment({
  userId: "user_abc",
  taskId: "node_01kq...",
});

// Current state
console.log(detail.status, detail.dueOn, detail.owner?.label);

// History: all prior status changes
const statusHistory = detail.history.filter(
  (e) => e.predicate === "HAS_TASK_STATUS",
);
```

---

## Candidate review

### `getCandidateCommitments`

Returns Task nodes whose latest personal `HAS_TASK_STATUS` is `assistant_inferred` — tasks the ingestion extractor proposed but the user has not yet confirmed. Deliberately excluded from `getOpenCommitments`.

**Route:** `POST /commitments/candidates`

**Request / Response:** same shape as `getOpenCommitments`.

```ts
const { commitments } = await client.getCandidateCommitments({
  userId: "user_abc",
});
```

---

### `confirmCommitment`

Promotes a candidate task's `HAS_TASK_STATUS` from `assistant_inferred` to `user_confirmed`, moving it into the open-commitments view. The status _value_ (`pending`/`in_progress`) is preserved; only the provenance is elevated.

**Route:** `POST /commitments/confirm`

**Request**

| Field    | Type     | Required |
| -------- | -------- | -------- |
| `userId` | `string` | yes      |
| `taskId` | `nodeId` | yes      |

**Response**

| Field     | Type         | Notes                                             |
| --------- | ------------ | ------------------------------------------------- |
| `taskId`  | `nodeId`     |                                                   |
| `status`  | `TaskStatus` | The status preserved by confirmation.             |
| `claimId` | `claimId`    | The new `user_confirmed` `HAS_TASK_STATUS` claim. |

```ts
const confirmed = await client.confirmCommitment({
  userId: "user_abc",
  taskId: "node_01kq...",
});
```

---

### `dismissCommitment`

Retracts the active `HAS_TASK_STATUS` on a task, removing it from both the open and candidate views. Records no sticky rejection — the task can reappear if re-extracted.

**Route:** `POST /commitments/dismiss`

**Request**

| Field    | Type     | Required |
| -------- | -------- | -------- |
| `userId` | `string` | yes      |
| `taskId` | `nodeId` | yes      |

**Response**

| Field               | Type        | Notes                                                                     |
| ------------------- | ----------- | ------------------------------------------------------------------------- |
| `taskId`            | `nodeId`    |                                                                           |
| `retractedClaimIds` | `claimId[]` | The `HAS_TASK_STATUS` claims retracted (may be empty if already cleared). |

```ts
await client.dismissCommitment({
  userId: "user_abc",
  taskId: "node_01kq...",
});
```

---

## Typical flows

### (a) Open a task, mark in progress, then done

```ts
const client = new MemoryClient({ baseUrl: "...", apiKey: "..." });
const userId = "user_abc";

// 1. Create
const { taskId } = await client.createCommitment({
  userId,
  label: "Write integration tests for auth module",
  dueOn: "2026-07-15",
});

// 2. Start working on it
await client.setCommitmentStatus({
  userId,
  taskId,
  status: "in_progress",
});

// 3. Complete
await client.setCommitmentStatus({
  userId,
  taskId,
  status: "done",
  note: "All 47 tests green",
});
```

### (b) Browse tasks with paging, filters, and search

```ts
// All pending/in_progress tasks matching "auth", oldest first
let cursor: string | undefined;
do {
  const page = await client.listCommitments({
    userId: "user_abc",
    statuses: ["pending", "in_progress"],
    search: "auth",
    sort: "createdAt",
    order: "asc",
    limit: 25,
    cursor,
  });
  for (const task of page.commitments) {
    console.log(task.label, task.status, task.dueOn);
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

### (c) Inspect one task — current state, history, and sources

```ts
const detail = await client.getCommitment({
  userId: "user_abc",
  taskId: "node_01kq...",
  includeHistory: true,
  includeSources: true,
});

// Current state
console.log(detail.status); // "done"
console.log(detail.statusClaimId); // the active claim id
console.log(detail.owner?.label); // "Marcel"
console.log(detail.dueOn); // "2026-07-15"

// All status transitions in reverse-chronological order
const transitions = detail.history
  .filter((e) => e.predicate === "HAS_TASK_STATUS")
  .map((e) => `${e.statedAt.toISOString()} → ${e.value} (${e.status})`);

// Evidence: what conversation or document originated this task
for (const src of detail.sources) {
  console.log(src.type, src.title ?? "(untitled)", src.ingestedAt);
}
```

### (d) Review and act on candidate tasks

```ts
const { commitments: candidates } = await client.getCandidateCommitments({
  userId: "user_abc",
});

for (const c of candidates) {
  if (shouldConfirm(c)) {
    await client.confirmCommitment({ userId: "user_abc", taskId: c.taskId });
  } else {
    await client.dismissCommitment({ userId: "user_abc", taskId: c.taskId });
  }
}
```

---

## Notes

- **`assertedByKind` values:** `"user"` | `"user_confirmed"` | `"assistant_inferred"` | `"participant"` | `"document_author"` | `"system"`. Most callers should use `"user"` (the default).
- **`description` is Task-only:** editing `description` via `updateCommitment` is valid because a Task's description is user-authored. The generic `POST /node/update` route rejects `description` edits on knowledge nodes.
- **Idempotent status re-assertion:** calling `setCommitmentStatus` with the same value the task already has is allowed; it records a fresh claim with the current timestamp.
- **Cursor opacity:** `nextCursor` is a base64url-encoded keyset value. Do not parse or construct it; treat it as an opaque token.
