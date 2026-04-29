import { TaskStatusEnum } from "~/types/graph.js";
import { typeIdSchema } from "~/types/typeid.js";
import { z } from "zod";

export const openCommitmentsRequestSchema = z.object({
  userId: z.string(),
  ownedBy: typeIdSchema("node").optional(),
  dueBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .optional(),
});

export const openCommitmentSchema = z.object({
  taskId: typeIdSchema("node"),
  label: z.string().nullable(),
  status: TaskStatusEnum.extract(["pending", "in_progress"]),
  owner: z
    .object({
      nodeId: typeIdSchema("node"),
      label: z.string().nullable(),
    })
    .nullable(),
  dueOn: z.string().nullable(),
  statedAt: z.coerce.date(),
  sourceId: typeIdSchema("source"),
});

export const openCommitmentsResponseSchema = z.object({
  commitments: z.array(openCommitmentSchema),
});

export type OpenCommitmentsRequest = z.infer<
  typeof openCommitmentsRequestSchema
>;
export type OpenCommitment = z.infer<typeof openCommitmentSchema>;
export type OpenCommitmentsResponse = z.infer<
  typeof openCommitmentsResponseSchema
>;
