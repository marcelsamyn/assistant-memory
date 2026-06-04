import { AssertedByKindEnum, TaskStatusEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Open a new commitment (a `Task` node) in one call.
 *
 * Counterpart to the read-only `getOpenCommitments` view and the
 * `setCommitmentDue` mutation: where those surface and re-date commitments the
 * ingestion extractor already minted, this lets a trusted client (assistant or
 * UI) create one deliberately the moment the user commits to something.
 *
 * The server creates the `Task` node and bootstraps it with a `HAS_TASK_STATUS`
 * claim (so it is never observable in a half-bootstrapped, status-less state),
 * plus an optional `DUE_ON` claim — resolving the canonical Temporal node
 * internally — and an optional `OWNED_BY` claim to a referenced entity. A fresh
 * commitment therefore deserialises identically to one returned by
 * `getOpenCommitments`.
 *
 * Always creates a new Task; it does not dedupe against existing open
 * commitments with the same label.
 */
export const createCommitmentRequestSchema = z.object({
  userId: z.string(),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  /**
   * Status at creation. A commitment can only open as `pending` or
   * `in_progress`; `done`/`abandoned` are reached later via a superseding
   * `HAS_TASK_STATUS` claim, not at creation. Defaults to `pending`.
   */
  status: TaskStatusEnum.extract(["pending", "in_progress"]).default("pending"),
  /**
   * Optional due date as `YYYY-MM-DD`. The server resolves (or creates) the
   * canonical Temporal day node and asserts a `DUE_ON` claim.
   */
  dueOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "dueOn must be YYYY-MM-DD")
    .optional(),
  /**
   * Optional owner: the node id of the entity (typically a `Person`) that owns
   * the commitment. Emits an `OWNED_BY` claim. Must be an existing node owned
   * by `userId`, otherwise the call fails before any node is written.
   */
  ownedBy: typeIdSchema("node").optional(),
  /**
   * Provenance for the asserted claims. Defaults to `"user"`.
   */
  assertedByKind: AssertedByKindEnum.optional(),
});

export const createCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string(),
  status: TaskStatusEnum.extract(["pending", "in_progress"]),
  dueOn: z.string().nullable(),
  owner: z
    .object({
      nodeId: typeIdSchema("node"),
      label: z.string().nullable(),
    })
    .nullable(),
  /** ID of the bootstrapped `HAS_TASK_STATUS` claim. Always present. */
  statusClaimId: typeIdSchema("claim"),
  /** ID of the `DUE_ON` claim, or `null` when no due date was supplied. */
  dueClaimId: typeIdSchema("claim").nullable(),
  /** ID of the `OWNED_BY` claim, or `null` when no owner was supplied. */
  ownerClaimId: typeIdSchema("claim").nullable(),
});

export type CreateCommitmentRequest = z.infer<
  typeof createCommitmentRequestSchema
>;
export type CreateCommitmentResponse = z.infer<
  typeof createCommitmentResponseSchema
>;
