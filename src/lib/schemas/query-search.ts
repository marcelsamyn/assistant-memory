import { EdgeTypeEnum, NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { rerankResultItemSchema } from "../schemas/rerank.js";
import { z } from "zod";

// Define the request schema
export const querySearchRequestSchema = z.object({
  userId: z.string(),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
  excludeNodeTypes: z
    .array(NodeTypeEnum)
    .default([NodeTypeEnum.enum.AssistantDream, NodeTypeEnum.enum.Temporal]),
  conversationId: z.string().optional(),
});

// Define schemas for the search result types
export const nodeSearchResultSchema = z.object({
  id: typeIdSchema("node"),
  type: NodeTypeEnum,
  timestamp: z.coerce.date(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  similarity: z.number(),
  sourceIds: z.array(z.string()).optional(),
});

export const edgeSearchResultSchema = z.object({
  id: typeIdSchema("edge"),
  sourceNodeId: typeIdSchema("node"),
  targetNodeId: typeIdSchema("node"),
  sourceLabel: z.string().nullable(),
  targetLabel: z.string().nullable(),
  edgeType: EdgeTypeEnum,
  description: z.string().nullable(),
  similarity: z.number(),
  timestamp: z.coerce.date(),
});

export const oneHopNodeSchema = z.object({
  id: typeIdSchema("node"),
  type: NodeTypeEnum,
  timestamp: z.coerce.date(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  edgeSourceId: typeIdSchema("node"),
  edgeTargetId: typeIdSchema("node"),
  edgeType: EdgeTypeEnum,
  sourceLabel: z.string().nullable(),
  targetLabel: z.string().nullable(),
  sourceIds: z.array(z.string()).optional(),
});

// Define the discriminated union for search results
export const searchResultItemSchema = z.discriminatedUnion("group", [
  rerankResultItemSchema(nodeSearchResultSchema).extend({
    group: z.literal("similarNodes"),
  }),
  rerankResultItemSchema(edgeSearchResultSchema).extend({
    group: z.literal("similarEdges"),
  }),
  rerankResultItemSchema(oneHopNodeSchema).extend({
    group: z.literal("connections"),
  }),
]);

// Define the search results array schema
export const searchResultsSchema = z.array(searchResultItemSchema);

export const querySearchResponseSchema = z.object({
  query: z.string(),
  formattedResult: z.string(),
  searchResults: searchResultsSchema,
});

export type QuerySearchRequest = z.infer<typeof querySearchRequestSchema>;
export type QuerySearchResponse = z.infer<typeof querySearchResponseSchema>;
