import { MessageSchema } from "../jobs/ingest-conversation";
import { searchResultsSchema } from "../schemas/query-search";
import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const DeepResearchJobInputSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  conversationId: z.string(),
  messages: z.array(MessageSchema),
  lastNMessages: z.number().int().positive().default(3),
});

export type DeepResearchJobInput = z.infer<typeof DeepResearchJobInputSchema>;

// Use the same SearchResults schema structure from query-search
export const DeepResearchResultSchema = z.object({
  conversationId: z.string(),
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  results: searchResultsSchema,
  timestamp: z.coerce.date(), // Use coerce to automatically convert string to Date
  ttl: z.number().int().positive(),
});

export type DeepResearchResult = z.infer<typeof DeepResearchResultSchema>;
