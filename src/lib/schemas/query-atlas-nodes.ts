import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const queryAtlasNodesRequestSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  assistantId: z.string(),
});

export const queryAtlasNodesResponseSchema = z.object({
  nodeIds: z.array(z.string()),
});

export type QueryAtlasNodesRequest = z.infer<
  typeof queryAtlasNodesRequestSchema
>;
export type QueryAtlasNodesResponse = z.infer<
  typeof queryAtlasNodesResponseSchema
>;
