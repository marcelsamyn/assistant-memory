/**
 * REST/SDK schemas for `POST /maintenance/recover-statusless-commitments`.
 *
 * Repairs the Task⟺status invariant for existing data: every `Task` node is
 * supposed to carry an active `HAS_TASK_STATUS` claim, but tasks minted before
 * the ingestion/`createNode` guards (or whose only status claim was dropped as
 * off-vocabulary) can exist with no status at all — invisible to every
 * commitment surface yet present in node/type/search queries, and unprotected
 * from the staleness sweep.
 *
 * This sweep finds Task nodes with NO `HAS_TASK_STATUS` claim in ANY lifecycle
 * state and gives them a default candidate-band status so they surface as
 * candidates. The "any state" predicate is the carve-out that EXCLUDES
 * deliberately-dismissed tasks (whose status was retracted) — those are left
 * for orphan pruning, not resurrected. Additive and idempotent: re-running it
 * is safe (a repaired task now has a status, so it no longer matches), which is
 * also why it doubles as an ongoing self-heal net.
 */
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid.js";

export const recoverStatuslessCommitmentsRequestSchema = z.object({
  userId: z.string(),
  limit: z.number().int().positive().max(10_000).default(1_000),
  sampleLimit: z.number().int().nonnegative().max(500).default(50),
  /**
   * Dry run by default: returns the candidate count and sample without writing.
   * Set `dryRun: false` to create the default status claims after inspecting
   * counts. Unlike the prune sweeps this is additive (no deletion), but the
   * preview-then-apply default keeps maintenance ergonomics uniform.
   */
  dryRun: z.boolean().default(true),
});

export type RecoverStatuslessCommitmentsRequest = z.input<
  typeof recoverStatuslessCommitmentsRequestSchema
>;

export const statuslessTaskSchema = z.object({
  id: typeIdSchema("node"),
  label: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const recoverStatuslessCommitmentsResponseSchema = z.object({
  dryRun: z.boolean(),
  /** Statusless Task nodes found (bounded by `limit`). */
  candidateCount: z.number().int().nonnegative(),
  /** Tasks given a default status this run (0 on a dry run). */
  recoveredCount: z.number().int().nonnegative(),
  /** True when more statusless tasks remain beyond `limit`. */
  hasMore: z.boolean(),
  candidates: z.array(statuslessTaskSchema),
});

export type StatuslessTask = z.infer<typeof statuslessTaskSchema>;
export type RecoverStatuslessCommitmentsResponse = z.infer<
  typeof recoverStatuslessCommitmentsResponseSchema
>;
