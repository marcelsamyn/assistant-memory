import { AssertedByKindEnum, TaskStatusEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Advance a Task's lifecycle status in one call.
 *
 * Asserts a new `HAS_TASK_STATUS` claim with the requested value; the
 * predicate lifecycle engine supersedes the prior active status claim
 * automatically. Unlike `createCommitment` (which can only open as
 * `pending`/`in_progress`), all four statuses are reachable here — `done`
 * and `abandoned` are reached only through this superseding path.
 *
 * The `previous*` fields echo the status that was just superseded so callers
 * (e.g. Petals) can offer optimistic updates and one-click undo without a
 * second read.
 */
export const setCommitmentStatusRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  /** Target status. All four values are allowed (unlike `createCommitment`). */
  status: TaskStatusEnum,
  /** Optional note stored on the new claim's `description`. */
  note: z.string().min(1).optional(),
  /** Provenance for the new `HAS_TASK_STATUS` claim. Defaults to `"user"`. */
  assertedByKind: AssertedByKindEnum.optional(),
});

export const setCommitmentStatusResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  status: TaskStatusEnum,
  /** ID of the newly asserted `HAS_TASK_STATUS` claim. */
  claimId: typeIdSchema("claim"),
  /** Status of the superseded claim, or `null` when none was active. */
  previousStatus: TaskStatusEnum.nullable(),
  /** ID of the superseded claim, or `null` when none was active. */
  previousClaimId: typeIdSchema("claim").nullable(),
});

export type SetCommitmentStatusRequest = z.infer<
  typeof setCommitmentStatusRequestSchema
>;
export type SetCommitmentStatusResponse = z.infer<
  typeof setCommitmentStatusResponseSchema
>;
