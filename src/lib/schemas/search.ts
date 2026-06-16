/**
 * Request/response schemas for the hybrid explicit-search route (`POST /search`).
 * Distinct from `/context/search` (card-shaped, semantic background context):
 * this surface returns ranked hits with highlights for intentional lookups.
 *
 * Common aliases: search schema, explicit search, hybrid search, SearchHit.
 */
import { z } from "zod";
import { NodeTypeEnum } from "~/types/graph.js";

export const searchRequestSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional().default(20),
  scope: z.enum(["personal", "reference"]).optional().default("personal"),
  filters: z
    .object({
      /** Restrict hits to these entity (node) types. */
      entityTypes: z.array(NodeTypeEnum).optional(),
      /** Restrict claim hits to this stated_at range (inclusive). */
      statedBetween: z
        .object({
          from: z.coerce.date().optional(),
          to: z.coerce.date().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

const sourceTypeEnum = z.enum([
  "conversation",
  "conversation_message",
  "document",
  "legacy_migration",
  "manual",
  "meeting_transcript",
  "external_conversation",
  "metric_push",
  "metric_manual",
  "rollup",
]);

export const searchHitSchema = z.object({
  kind: z.enum(["node", "claim"]),
  nodeId: z.string(),
  claimId: z.string().optional(),
  text: z.string(),
  highlight: z.string(),
  score: z.number(),
  source: z.object({
    sourceId: z.string(),
    type: sourceTypeEnum,
    title: z.string().nullish(),
    author: z.string().nullish(),
  }),
  statedAt: z.coerce.date().optional(),
});
export type SearchHit = z.infer<typeof searchHitSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  hits: z.array(searchHitSchema),
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;
