import { z } from "zod";
import { ScopeEnum } from "~/types/graph.js";

export const ingestDocumentRequestSchema = z.object({
  userId: z.string(),
  updateExisting: z.boolean().optional().default(false),
  document: z.object({
    id: z.string(),
    content: z.string(),
    scope: ScopeEnum.optional().default("personal"),
    timestamp: z.string().datetime().pipe(z.coerce.date()).optional(), // Timestamp is optional
  }),
});

export const ingestDocumentResponseSchema = z.object({
  message: z.string(),
  jobId: z.string(),
});

export type IngestDocumentRequest = z.infer<typeof ingestDocumentRequestSchema>;
export type IngestDocumentResponse = z.infer<
  typeof ingestDocumentResponseSchema
>;
