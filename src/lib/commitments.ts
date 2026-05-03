/** Lifecycle-aware commitment operations (Task subject helpers). */
import { format, parseISO } from "date-fns";
import { and, eq } from "drizzle-orm";
import { claims, nodes } from "~/db/schema";
import { createClaim, updateClaim } from "~/lib/claim";
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

  const [taskRow] = await db
    .select({ id: nodes.id, nodeType: nodes.nodeType })
    .from(nodes)
    .where(and(eq(nodes.id, taskId), eq(nodes.userId, userId)))
    .limit(1);

  if (!taskRow || taskRow.nodeType !== "Task") {
    throw new TaskNotFoundError(taskId);
  }

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
