/** Lifecycle-aware commitment operations (Task subject helpers). */
import { format, parseISO } from "date-fns";
import { and, desc, eq } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import { createClaim, updateClaim, NodesNotFoundError } from "~/lib/claim";
import { coerceTaskStatus } from "~/lib/claims/task-status";
import { createNode } from "~/lib/node";
import type {
  CommitmentActionRequest,
  ConfirmCommitmentResponse,
  DismissCommitmentResponse,
} from "~/lib/schemas/commitment-action";
import type {
  CreateCommitmentRequest,
  CreateCommitmentResponse,
} from "~/lib/schemas/create-commitment";
import type { CreateNodeInitialClaim } from "~/lib/schemas/node";
import type { SetCommitmentDueRequest } from "~/lib/schemas/set-commitment-due";
import { ensureDayNode } from "~/lib/temporal";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export class TaskNotFoundError extends Error {
  readonly taskId: TypeId<"node">;
  constructor(taskId: TypeId<"node">) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

/**
 * The Task's active `HAS_TASK_STATUS` carries an objectValue outside the
 * canonical vocabulary and couldn't be coerced — corrupt state that predates
 * the write-time guard (and should have been swept by migration 0016).
 */
export class InvalidTaskStatusError extends Error {
  readonly taskId: TypeId<"node">;
  readonly objectValue: string;
  constructor(taskId: TypeId<"node">, objectValue: string) {
    super(`Task ${taskId} has an unrecognized status: ${objectValue}`);
    this.name = "InvalidTaskStatusError";
    this.taskId = taskId;
    this.objectValue = objectValue;
  }
}

/** Verify `taskId` is a `Task` owned by `userId`; throws {@link TaskNotFoundError} otherwise. */
async function requireOwnedTask(
  db: Awaited<ReturnType<typeof useDatabase>>,
  userId: string,
  taskId: TypeId<"node">,
): Promise<void> {
  const [taskRow] = await db
    .select({ id: nodes.id, nodeType: nodes.nodeType })
    .from(nodes)
    .where(and(eq(nodes.id, taskId), eq(nodes.userId, userId)))
    .limit(1);

  if (!taskRow || taskRow.nodeType !== "Task") {
    throw new TaskNotFoundError(taskId);
  }
}

/**
 * Set or clear a Task's `DUE_ON` claim.
 *
 * - `dueOn: "YYYY-MM-DD"` → resolve/create the canonical Temporal node and
 *   assert a new `DUE_ON` claim. The predicate-policy override for `Task`
 *   subjects supersedes any prior active `DUE_ON` claim automatically.
 * - `dueOn: null` → retract every active `DUE_ON` claim on the task. No new
 *   claim is asserted.
 *
 * Verifies the subject is a `Task` owned by the user before doing anything;
 * cross-user / wrong-type calls throw {@link TaskNotFoundError}.
 */
export async function setCommitmentDue(
  input: SetCommitmentDueRequest,
): Promise<{
  taskId: TypeId<"node">;
  dueOn: string | null;
  claimId: TypeId<"claim"> | null;
  retractedClaimIds: TypeId<"claim">[];
}> {
  const { userId, taskId, dueOn, note, assertedByKind } = input;
  const db = await useDatabase();

  await requireOwnedTask(db, userId, taskId);

  if (dueOn === null) {
    const activeDueClaims = await db
      .select({ id: claims.id })
      .from(claims)
      .where(
        and(
          eq(claims.userId, userId),
          eq(claims.subjectNodeId, taskId),
          eq(claims.predicate, "DUE_ON"),
          eq(claims.status, "active"),
        ),
      );

    const retractedClaimIds: TypeId<"claim">[] = [];
    for (const claim of activeDueClaims) {
      const updated = await updateClaim(userId, claim.id, {
        status: "retracted",
      });
      if (updated) retractedClaimIds.push(updated.id);
    }

    return { taskId, dueOn: null, claimId: null, retractedClaimIds };
  }

  // Resolve or create the canonical Temporal node for the requested date.
  // Parse with `parseISO` so `YYYY-MM-DD` lands at the start of that calendar
  // day in UTC, matching how ingestion-time day nodes are labelled.
  const targetDate = parseISO(dueOn);
  const dayNodeId = await ensureDayNode(db, userId, targetDate);

  const created = await createClaim({
    userId,
    subjectNodeId: taskId,
    predicate: "DUE_ON",
    statement: `Task due on ${dueOn}`,
    objectNodeId: dayNodeId,
    description: note,
    assertedByKind,
    statedAt: new Date(),
  });

  return {
    taskId,
    dueOn: format(targetDate, "yyyy-MM-dd"),
    claimId: created.id,
    retractedClaimIds: [],
  };
}

/**
 * Open a new commitment as a `Task` node bootstrapped with its claims.
 *
 * Delegates node creation (metadata, embedding, manual source, today's day
 * link) to {@link createNode}, supplying the commitment-specific
 * `initialClaims`: a mandatory `HAS_TASK_STATUS` (so the task is never
 * observable without a status), plus an optional `DUE_ON` — resolving the
 * canonical Temporal node via {@link ensureDayNode} — and an optional
 * `OWNED_BY`. Because `createNode` rolls the node back if any claim fails, a
 * bad `ownedBy` leaves nothing behind.
 *
 * Always creates a new Task; callers wanting to advance an existing task's
 * status or date use `createClaim` / {@link setCommitmentDue} instead.
 */
export async function createCommitment(
  input: CreateCommitmentRequest,
): Promise<CreateCommitmentResponse> {
  const { userId, label, description, status, dueOn, ownedBy, assertedByKind } =
    input;
  const db = await useDatabase();

  // Resolve the owner up-front: it yields a natural-language OWNED_BY statement
  // and lets the response echo the same `{ nodeId, label }` shape as the
  // open-commitments view. Existence is enforced here (createClaim re-checks)
  // so a bad owner fails before any node is written.
  let ownerLabel: string | null = null;
  if (ownedBy !== undefined) {
    const [ownerRow] = await db
      .select({ label: nodeMetadata.label })
      .from(nodes)
      .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(and(eq(nodes.id, ownedBy), eq(nodes.userId, userId)))
      .limit(1);
    if (!ownerRow) throw new NodesNotFoundError(userId, [ownedBy]);
    ownerLabel = ownerRow.label ?? null;
  }

  // HAS_TASK_STATUS first so its claim id is index 0; DUE_ON and OWNED_BY are
  // appended only when supplied, and their positions are captured so we can map
  // createNode's ordered `initialClaimIds` back onto the response.
  const initialClaims: CreateNodeInitialClaim[] = [
    {
      predicate: "HAS_TASK_STATUS",
      statement: `${label} is ${status}.`,
      objectValue: status,
      assertedByKind,
    },
  ];

  let dueIndex: number | null = null;
  if (dueOn !== undefined) {
    const dueNodeId = await ensureDayNode(db, userId, parseISO(dueOn));
    dueIndex =
      initialClaims.push({
        predicate: "DUE_ON",
        statement: `${label} is due on ${dueOn}.`,
        objectNodeId: dueNodeId,
        assertedByKind,
      }) - 1;
  }

  let ownerIndex: number | null = null;
  if (ownedBy !== undefined) {
    ownerIndex =
      initialClaims.push({
        predicate: "OWNED_BY",
        statement: ownerLabel
          ? `${label} is owned by ${ownerLabel}.`
          : `${label} is owned by a referenced entity.`,
        objectNodeId: ownedBy,
        assertedByKind,
      }) - 1;
  }

  const created = await createNode(
    userId,
    "Task",
    label,
    description,
    initialClaims,
  );

  const ids = created.initialClaimIds;
  const statusClaimId = ids[0];
  if (statusClaimId === undefined) {
    throw new Error("createCommitment: status claim was not created");
  }

  return {
    taskId: created.id,
    label: created.label,
    status,
    dueOn: dueOn ?? null,
    owner:
      ownedBy !== undefined ? { nodeId: ownedBy, label: ownerLabel } : null,
    statusClaimId,
    dueClaimId: dueIndex === null ? null : (ids[dueIndex] ?? null),
    ownerClaimId: ownerIndex === null ? null : (ids[ownerIndex] ?? null),
  };
}

/**
 * Confirm a candidate commitment: re-assert its current `HAS_TASK_STATUS` as
 * `user_confirmed`. The lifecycle engine supersedes the prior (typically
 * `assistant_inferred`) claim, so the task graduates from the candidate view
 * into {@link getOpenCommitments}. The status value is preserved — confirmation
 * elevates provenance, not progress.
 *
 * Throws {@link TaskNotFoundError} if the subject isn't a Task owned by the
 * user, or has no active `HAS_TASK_STATUS` to confirm.
 */
export async function confirmCommitment(
  input: CommitmentActionRequest,
): Promise<ConfirmCommitmentResponse> {
  const { userId, taskId } = input;
  const db = await useDatabase();

  await requireOwnedTask(db, userId, taskId);

  const [statusRow] = await db
    .select({ objectValue: claims.objectValue })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, taskId),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        eq(claims.status, "active"),
      ),
    )
    .orderBy(desc(claims.statedAt), desc(claims.createdAt))
    .limit(1);

  if (!statusRow || statusRow.objectValue === null) {
    throw new TaskNotFoundError(taskId);
  }

  const status = coerceTaskStatus(statusRow.objectValue);
  if (status === null) {
    throw new InvalidTaskStatusError(taskId, statusRow.objectValue);
  }

  const created = await createClaim({
    userId,
    subjectNodeId: taskId,
    predicate: "HAS_TASK_STATUS",
    statement: `Task confirmed as ${status}.`,
    objectValue: status,
    assertedByKind: "user_confirmed",
    statedAt: new Date(),
  });

  return { taskId, status, claimId: created.id };
}

/**
 * Dismiss a commitment: retract every active `HAS_TASK_STATUS` claim on the
 * task. With no active status it disappears from both the open and candidate
 * views (both require one). Per the "retract only" policy this records no
 * sticky rejection — a much-later re-inference may resurface it.
 *
 * Idempotent: a task with nothing active retracts nothing and returns an empty
 * list. Throws {@link TaskNotFoundError} only when the subject isn't a Task
 * owned by the user.
 */
export async function dismissCommitment(
  input: CommitmentActionRequest,
): Promise<DismissCommitmentResponse> {
  const { userId, taskId } = input;
  const db = await useDatabase();

  await requireOwnedTask(db, userId, taskId);

  const activeStatusClaims = await db
    .select({ id: claims.id })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, taskId),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        eq(claims.status, "active"),
      ),
    );

  const retractedClaimIds: TypeId<"claim">[] = [];
  for (const claim of activeStatusClaims) {
    const updated = await updateClaim(userId, claim.id, {
      status: "retracted",
    });
    if (updated) retractedClaimIds.push(updated.id);
  }

  return { taskId, retractedClaimIds };
}
