import { NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const mergeNodesRequestSchema = z.object({
  userId: z.string(),
  nodeIds: z.array(typeIdSchema("node")).min(2),
  targetLabel: z.string().optional(),
  targetDescription: z.string().optional(),
});

export const mergeNodesResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string(),
    description: z.string().nullable(),
  }),
});

export type MergeNodesRequest = z.infer<typeof mergeNodesRequestSchema>;
export type MergeNodesResponse = z.infer<typeof mergeNodesResponseSchema>;
