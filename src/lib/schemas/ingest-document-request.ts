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
    /**
     * Optional bibliographic metadata for reference-scope documents
     * (author/title surface in `searchReference` and `getNodeCard` via the
     * `NodeCard.reference` field). Both fields are independently optional so
     * sources may carry one without the other; ignored for personal docs but
     * still stored on `sources.metadata` so a later scope flip preserves them.
     */
    author: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
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
