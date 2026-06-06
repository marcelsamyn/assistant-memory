import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

/**
 * Rename a Task and/or edit its description.
 *
 * A Task's `label` and `description` are user-authored node metadata (set by
 * `createCommitment`), so editing them is safe — unlike knowledge nodes, whose
 * descriptions are generated from sourced claims and which `POST /node/update`
 * deliberately 405s on. This Task-scoped path re-uses the node-metadata update
 * code and re-embeds when either field changes.
 *
 * At least one of `label` / `description` must be provided. Passing
 * `description: ""` clears the description.
 */
export const updateCommitmentRequestSchema = z
  .object({
    userId: z.string(),
    taskId: typeIdSchema("node"),
    /** New label. Omit to leave the label unchanged. */
    label: z.string().min(1).optional(),
    /** New description; `""` clears it. Omit to leave the description unchanged. */
    description: z.string().optional(),
  })
  .refine((v) => v.label !== undefined || v.description !== undefined, {
    message: "Provide at least one of label or description",
  });

export const updateCommitmentResponseSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  description: z.string().nullable(),
});

export type UpdateCommitmentRequest = z.infer<
  typeof updateCommitmentRequestSchema
>;
export type UpdateCommitmentResponse = z.infer<
  typeof updateCommitmentResponseSchema
>;
