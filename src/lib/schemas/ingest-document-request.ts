import { z } from "zod";
import { ScopeEnum } from "~/types/graph.js";
import { typeIdSchema } from "~/types/typeid.js";

export const ingestDocumentRequestSchema = z.object({
  userId: z.string(),
  updateExisting: z.boolean().optional().default(false),
  document: z.object({
    id: z.string(),
    content: z.string(),
    /**
     * Format of `content`. `markdown` (default) and `text` are stored
     * as-is; `html` is converted to markdown server-side via the
     * markitdown sidecar so JavaScript/CSS/inline noise is stripped
     * before extraction.
     */
    contentType: z
      .enum(["markdown", "text", "html"])
      .optional()
      .default("markdown"),
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
  /**
   * Synchronously-generated source row id for the ingested document. The
   * worker hasn't finished extraction yet at the time this is returned, so
   * callers can use this id to render a "processing" placeholder, attach
   * the source to a project, or poll `getSource()` until status flips to
   * `completed`.
   */
  sourceId: typeIdSchema("source"),
});

export type IngestDocumentRequest = z.infer<typeof ingestDocumentRequestSchema>;
export type IngestDocumentResponse = z.infer<
  typeof ingestDocumentResponseSchema
>;
