import {
  AssertedByKindEnum,
  ClaimStatusEnum,
  ScopeEnum,
  TaskStatusEnum,
} from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Detail read model for a single commitment: current state, lifecycle history,
 * and evidence sources. Reuses `getNodeById` for a one-query node + history
 * slice across the three task predicates (`HAS_TASK_STATUS`, `OWNED_BY`,
 * `DUE_ON`), then batch-resolves the distinct source ids.
 */
export const getCommitmentRequestSchema = z.object({
  userId: z.string(),
  taskId: typeIdSchema("node"),
  /** Include the full lifecycle history of the three task predicates. */
  includeHistory: z.boolean().default(true),
  /** Include the distinct evidence sources behind the task's claims. */
  includeSources: z.boolean().default(true),
});

export const taskLifecycleEntrySchema = z.object({
  claimId: typeIdSchema("claim"),
  predicate: z.enum(["HAS_TASK_STATUS", "OWNED_BY", "DUE_ON"]),
  /** `objectValue` (status) or `objectLabel` (owner / due) of the claim. */
  value: z.string().nullable(),
  objectNodeId: typeIdSchema("node").nullable(),
  status: ClaimStatusEnum,
  assertedByKind: AssertedByKindEnum,
  sourceId: typeIdSchema("source"),
  statedAt: z.coerce.date(),
});

/**
 * Evidence source shape — deliberately NOT `sourceSummarySchema`, whose `type`
 * is the listable enum that EXCLUDES `"manual"`. User-created tasks carry a
 * `manual` source, so `type` is a plain string here to admit every source type.
 */
export const commitmentSourceSchema = z.object({
  sourceId: typeIdSchema("source"),
  type: z.string(),
  title: z.string().nullable(),
  scope: ScopeEnum,
  /** `lastIngestedAt` falling back to `createdAt`. */
  ingestedAt: z.coerce.date(),
});

export const getCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.coerce.date(),
  /** Active status value, or `null` when no active status (e.g. dismissed). */
  status: TaskStatusEnum.nullable(),
  statusClaimId: typeIdSchema("claim").nullable(),
  statusStatedAt: z.coerce.date().nullable(),
  statusAssertedByKind: AssertedByKindEnum.nullable(),
  owner: z
    .object({
      nodeId: typeIdSchema("node"),
      label: z.string().nullable(),
      claimId: typeIdSchema("claim"),
    })
    .nullable(),
  dueOn: z.string().nullable(),
  dueTime: z.string().nullable(),
  timeZone: z.string().nullable(),
  dueAt: z.coerce.date().nullable(),
  dueClaimId: typeIdSchema("claim").nullable(),
  /** Evidence sources; empty when `includeSources=false`. */
  sources: z.array(commitmentSourceSchema),
  /** Lifecycle history sorted `statedAt` desc; empty when `includeHistory=false`. */
  history: z.array(taskLifecycleEntrySchema),
});

export type GetCommitmentRequest = z.infer<typeof getCommitmentRequestSchema>;
export type TaskLifecycleEntry = z.infer<typeof taskLifecycleEntrySchema>;
export type CommitmentSource = z.infer<typeof commitmentSourceSchema>;
export type GetCommitmentResponse = z.infer<typeof getCommitmentResponseSchema>;
