import { EdgeTypeEnum, NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const queryGraphRequestSchema = z.object({
  userId: z.string(),
  query: z.string().optional(),
  maxNodes: z.number().int().positive().default(100),
});

export const queryGraphNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string(),
  description: z.string().nullable().optional(),
  sourceIds: z.array(z.string()).optional(),
});

export const queryGraphEdgeSchema = z.object({
  source: typeIdSchema("node"),
  target: typeIdSchema("node"),
  edgeType: EdgeTypeEnum,
  description: z.string().nullable().optional(),
});

export const queryGraphResponseSchema = z.object({
  nodes: z.array(queryGraphNodeSchema),
  edges: z.array(queryGraphEdgeSchema),
});

export type QueryGraphRequest = z.infer<typeof queryGraphRequestSchema>;
export type QueryGraphResponse = z.infer<typeof queryGraphResponseSchema>;
