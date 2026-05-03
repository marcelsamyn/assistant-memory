import { AssertedByKindEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Set or clear a Task's due date as a single, idempotent operation.
 *
 * Symmetric to the `dueOn` field returned by `getOpenCommitments`: callers
 * pass an ISO date (`YYYY-MM-DD`) to assert and any prior active `DUE_ON`
 * claim is superseded by the predicate lifecycle engine, or `null` to retract
 * the active `DUE_ON` claim and clear the date entirely.
 *
 * The server resolves (or creates) the canonical Temporal node for the date
 * internally, so callers don't need to know how Temporal nodes are labelled
 * or de-duplicated.
 */
export const setCommitmentDueRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  /**
   * `YYYY-MM-DD` to set the due date, or `null` to clear it. Pass the date
   * the user means in their own local context — the server normalises to
   * a Temporal day node keyed by the literal string.
   */
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dueOn must be YYYY-MM-DD or null")
    .nullable(),
  /**
   * Optional human-readable note attached to the new claim's description
   * (e.g. "client requested extra time"). Ignored when `dueOn` is `null`
   * because no new claim is asserted.
   */
  note: z.string().min(1).optional(),
  /**
   * Provenance for the new `DUE_ON` claim. Defaults to `"user"`. Has no
   * effect when `dueOn` is `null`.
   */
  assertedByKind: AssertedByKindEnum.optional(),
});

export const setCommitmentDueResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  dueOn: z.string().nullable(),
  /**
   * ID of the newly asserted `DUE_ON` claim. `null` when `dueOn` was set to
   * `null` (i.e. the operation only retracted prior claims).
   */
  claimId: typeIdSchema("claim").nullable(),
  /**
   * IDs of any previously active `DUE_ON` claims that this call retracted.
   * When `dueOn` is set, the lifecycle engine supersedes the prior claim
   * automatically and this stays empty; the field is only populated on the
   * explicit clear path (`dueOn: null`).
   */
  retractedClaimIds: z.array(typeIdSchema("claim")),
});

export type SetCommitmentDueRequest = z.infer<
  typeof setCommitmentDueRequestSchema
>;
export type SetCommitmentDueResponse = z.infer<
  typeof setCommitmentDueResponseSchema
>;
