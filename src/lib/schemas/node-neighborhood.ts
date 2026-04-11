import { typeIdSchema } from "../../types/typeid.js";
import { queryGraphNodeSchema, queryGraphEdgeSchema } from "./query-graph.js";
import { z } from "zod";

export const nodeNeighborhoodRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
  depth: z.union([z.literal(1), z.literal(2)]).default(1),
});

export const nodeNeighborhoodResponseSchema = z.object({
  nodes: z.array(queryGraphNodeSchema),
  edges: z.array(queryGraphEdgeSchema),
});

export type NodeNeighborhoodRequest = z.infer<
  typeof nodeNeighborhoodRequestSchema
>;
export type NodeNeighborhoodResponse = z.infer<
  typeof nodeNeighborhoodResponseSchema
>;
