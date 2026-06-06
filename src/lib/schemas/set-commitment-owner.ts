import { AssertedByKindEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Assign, reassign, or clear a Task's owner as a single, idempotent operation.
 *
 * A structural twin of `setCommitmentDue`:
 *
 * - `ownedBy: typeIdSchema("node")` → resolve the owner node's label and assert
 *   a new `OWNED_BY` claim. The predicate-policy override for `Task` subjects
 *   supersedes any prior active `OWNED_BY` claim automatically.
 * - `ownedBy: null` → retract every active `OWNED_BY` claim on the task. No new
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
   * Provenance for the new `OWNED_BY` claim. Defaults to `"user"`. Has no
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
   * ID of the newly asserted `OWNED_BY` claim. `null` when `ownedBy` was set
   * to `null` (i.e. the operation only retracted prior claims).
   */
  claimId: typeIdSchema("claim").nullable(),
  /**
   * IDs of any previously active `OWNED_BY` claims that this call retracted.
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
