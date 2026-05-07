/**
 * Schemas for the source-management read API used by hosts that attach
 * memory sources to projects (e.g. Petals' Knowledge tab).
 *
 * `POST /sources/list` — paginated enumeration with optional type filter.
 * `POST /sources/get`  — single-source lookup for chip rendering on a
 *                        project page when only the sourceId is on hand.
 *
 * The opaque `cursor` is intentionally unspecified at the contract level;
 * the server encodes whatever it needs to resume the scan.
 */
import { ScopeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const sourceListableTypeEnum = z.enum([
  "document",
  "conversation",
  "conversation_message",
  "meeting_transcript",
  "external_conversation",
]);
export type SourceListableType = z.infer<typeof sourceListableTypeEnum>;

export const sourceStatusEnum = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
  "summarized",
]);

export const sourceSummarySchema = z.object({
  sourceId: typeIdSchema("source"),
  type: sourceListableTypeEnum,
  /**
   * Best-effort display title. For documents this is whatever was passed
   * to ingestion (filename for `ingestFile`, explicit `title` for
   * `ingestDocument`); for conversations and other types it may be `null`
   * until a derived title is available.
   */
  title: z.string().nullable(),
  status: sourceStatusEnum,
  scope: ScopeEnum,
  ingestedAt: z.coerce.date(),
  /** Count of nodes this source contributed to (via `source_links`). */
  nodeCount: z.number().int().nonnegative(),
});
export type SourceSummary = z.infer<typeof sourceSummarySchema>;

export const listSourcesRequestSchema = z.object({
  userId: z.string(),
  type: sourceListableTypeEnum.optional(),
  limit: z.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
});
export type ListSourcesRequest = z.infer<typeof listSourcesRequestSchema>;

export const listSourcesResponseSchema = z.object({
  sources: z.array(sourceSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListSourcesResponse = z.infer<typeof listSourcesResponseSchema>;

export const getSourceRequestSchema = z.object({
  userId: z.string(),
  sourceId: typeIdSchema("source"),
});
export type GetSourceRequest = z.infer<typeof getSourceRequestSchema>;

export const getSourceResponseSchema = z.object({
  source: sourceSummarySchema,
});
export type GetSourceResponse = z.infer<typeof getSourceResponseSchema>;
