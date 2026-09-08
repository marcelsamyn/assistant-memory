import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const summarizeRequestSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
});

export const summarizeResponseSchema = z.object({
  message: z.string(),
});

export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;
export type SummarizeResponse = z.infer<typeof summarizeResponseSchema>;
