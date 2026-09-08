import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const queryAtlasRequestSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  assistantId: z.string(),
});

export const queryAtlasResponseSchema = z.object({
  atlas: z.string(),
});

export type QueryAtlasRequest = z.infer<typeof queryAtlasRequestSchema>;
export type QueryAtlasResponse = z.infer<typeof queryAtlasResponseSchema>;
