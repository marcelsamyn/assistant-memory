import { AssertedByKindEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Assign, reassign, or clear a Task's owner as a single, idempotent operation.
 *
 * A structural twin of `setCommitmentDue`:
 *
 * - `ownedBy: typeIdSchema("node")` → resolve the owner node's label and assert
 *   a new `ASSIGNED_TO` claim. The predicate policy supersedes any prior
 *   active `ASSIGNED_TO` claim automatically.
 * - `ownedBy: null` → retract every active `ASSIGNED_TO` claim on the task. No new
 *   claim is asserted.
 *
 * Verifies the subject is a `Task` owned by the user; cross-user / wrong-type
 * calls throw `TaskNotFoundError`, and a missing/cross-user owner throws
 * `NodesNotFoundError`.
 */
export const setCommitmentOwnerRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  /** Owner node id to assign, or `null` to clear the owner. */
  ownedBy: typeIdSchema("node").nullable(),
  /**
   * Optional note attached to the new claim's description. Ignored when
   * `ownedBy` is `null` because no new claim is asserted.
   */
  note: z.string().min(1).optional(),
  /**
   * Provenance for the new `ASSIGNED_TO` claim. Defaults to `"user"`. Has no
   * effect when `ownedBy` is `null`.
   */
  assertedByKind: AssertedByKindEnum.optional(),
});

export const setCommitmentOwnerResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  owner: z
    .object({
      nodeId: typeIdSchema("node"),
      label: z.string().nullable(),
    })
    .nullable(),
  /**
   * ID of the newly asserted `ASSIGNED_TO` claim. `null` when `ownedBy` was set
   * to `null` (i.e. the operation only retracted prior claims).
   */
  claimId: typeIdSchema("claim").nullable(),
  /**
   * IDs of any previously active `ASSIGNED_TO` claims that this call retracted.
   * When `ownedBy` is set, the lifecycle engine supersedes the prior claim
   * automatically and this stays empty; the field is only populated on the
   * explicit clear path (`ownedBy: null`).
   */
  retractedClaimIds: z.array(typeIdSchema("claim")),
});

export type SetCommitmentOwnerRequest = z.infer<
  typeof setCommitmentOwnerRequestSchema
>;
export type SetCommitmentOwnerResponse = z.infer<
  typeof setCommitmentOwnerResponseSchema
>;
