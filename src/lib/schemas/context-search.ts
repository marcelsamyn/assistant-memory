/**
 * Request/response schemas for the card-shaped search route
 * (`POST /context/search`) and the MCP `search_memory` / `search_reference`
 * tools. Response shape mirrors `searchMemory` / `searchReference` in
 * `src/lib/context/search-cards.ts`.
 *
 * Common aliases: contextSearch, contextSearchRequest, search-cards schema,
 * search_memory schema, search_reference schema.
 */
import { z } from "zod";
import { nodeCardSchema } from "~/lib/context/node-card-types.js";
import { claimEvidenceSchema } from "~/lib/context/types.js";
import { NodeTypeEnum } from "~/types/graph.js";

export const contextSearchRequestSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional().default(10),
  /**
   * Search scope. `personal` (default) routes through `searchMemory`,
   * `reference` through `searchReference`. The two scopes are deliberately
   * not unioned so reference material is never rendered as personal facts.
   */
  scope: z.enum(["personal", "reference"]).optional().default("personal"),
  /**
   * Optional node-type exclusions for the underlying similarity scan. Default
   * matches `/query/search` so card responses skip dream and temporal hits
   * unless explicitly requested.
   */
  excludeNodeTypes: z
    .array(NodeTypeEnum)
    .optional()
    .default([NodeTypeEnum.enum.AssistantDream, NodeTypeEnum.enum.Temporal]),
});
export type ContextSearchRequest = z.infer<typeof contextSearchRequestSchema>;

export const contextSearchResponseSchema = z.object({
  query: z.string(),
  cards: z.array(nodeCardSchema),
  evidence: z.array(claimEvidenceSchema),
});
export type ContextSearchResponse = z.infer<typeof contextSearchResponseSchema>;

/**
 * MCP-tool variant of the request shape: scope is fixed by the tool name
 * (`search_memory` ↔ personal, `search_reference` ↔ reference) so the LLM
 * doesn't need to choose. `.shape` is mounted directly on the MCP server.
 */
export const cardSearchToolInputSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  excludeNodeTypes: z.array(NodeTypeEnum).optional(),
});
export type CardSearchToolInput = z.infer<typeof cardSearchToolInputSchema>;
