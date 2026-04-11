import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const batchDeleteNodesRequestSchema = z.object({
  userId: z.string(),
  nodeIds: z.array(typeIdSchema("node")).min(1),
});

export const batchDeleteNodesResponseSchema = z.object({
  deleted: z.literal(true),
  count: z.number().int().nonnegative(),
});

export type BatchDeleteNodesRequest = z.infer<typeof batchDeleteNodesRequestSchema>;
export type BatchDeleteNodesResponse = z.infer<typeof batchDeleteNodesResponseSchema>;
