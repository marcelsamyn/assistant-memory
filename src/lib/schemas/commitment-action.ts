import { TaskStatusEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Confirm or dismiss an existing commitment, addressed by its Task node id.
 * Both actions share this request shape; the verbs differ in effect:
 *
 * - confirm → promote the task's current `HAS_TASK_STATUS` to `user_confirmed`
 *   (supersedes any inferred claim), making it visible in the open-commitments
 *   view.
 * - dismiss → retract the active `HAS_TASK_STATUS`, removing the task from both
 *   the open and candidate views.
 */
export const commitmentActionRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
});

export const confirmCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  /** The status preserved by confirmation (it elevates provenance, not status). */
  status: TaskStatusEnum,
  /** ID of the new `user_confirmed` `HAS_TASK_STATUS` claim. */
  claimId: typeIdSchema("claim"),
});

export const dismissCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  /** IDs of the `HAS_TASK_STATUS` claims this call retracted (may be empty). */
  retractedClaimIds: z.array(typeIdSchema("claim")),
});

export type CommitmentActionRequest = z.infer<
  typeof commitmentActionRequestSchema
>;
export type ConfirmCommitmentResponse = z.infer<
  typeof confirmCommitmentResponseSchema
>;
export type DismissCommitmentResponse = z.infer<
  typeof dismissCommitmentResponseSchema
>;
