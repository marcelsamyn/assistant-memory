import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const ingestConversationRequestSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  conversation: z.object({
    id: z.string(),
    messages: z.array(
      z.object({
        id: z.string(),
        content: z.string(),
        role: z.string(),
        name: z.string().optional(),
        timestamp: z.string().datetime(), // Expect ISO string from client
      }),
    ),
  }),
});

export const ingestConversationResponseSchema = z.object({
  message: z.string(),
  jobId: z.string(),
});

export type IngestConversationRequest = z.infer<
  typeof ingestConversationRequestSchema
>;
export type IngestConversationResponse = z.infer<
  typeof ingestConversationResponseSchema
>;
