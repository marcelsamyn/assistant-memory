import { NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const sampleNodesRequestSchema = z.object({
  userId: z.string(),
  limit: z.number().int().min(1).max(24).default(6),
  nodeTypes: z.array(NodeTypeEnum).optional(),
});
export type SampleNodesRequest = z.infer<typeof sampleNodesRequestSchema>;

export const sampleNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string(),
  description: z.string().nullable(),
  connectionCount: z.number().int(),
});

export const sampleNodesResponseSchema = z.object({
  nodes: z.array(sampleNodeSchema),
});
export type SampleNodesResponse = z.infer<typeof sampleNodesResponseSchema>;
