import {
  ClaimStatusEnum,
  AssertedByKindEnum,
  NodeTypeEnum,
  PredicateEnum,
  ScopeEnum,
} from "../../types/graph.js";
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

export const claimSearchResultSchema = z.object({
  id: typeIdSchema("claim"),
  subjectNodeId: typeIdSchema("node"),
  objectNodeId: typeIdSchema("node").nullable(),
  objectValue: z.string().nullable(),
  subjectLabel: z.string().nullable(),
  objectLabel: z.string().nullable(),
  predicate: PredicateEnum,
  statement: z.string(),
  description: z.string().nullable(),
  sourceId: typeIdSchema("source"),
  scope: ScopeEnum,
  assertedByKind: AssertedByKindEnum,
  assertedByNodeId: typeIdSchema("node").nullable(),
  status: ClaimStatusEnum,
  statedAt: z.coerce.date(),
  similarity: z.number(),
  timestamp: z.coerce.date(),
});

export const oneHopNodeSchema = z.object({
  id: typeIdSchema("node"),
  type: NodeTypeEnum,
  timestamp: z.coerce.date(),
  label: z.string().nullable(),
  description: z.string().nullable(),
  claimSubjectId: typeIdSchema("node"),
  claimObjectId: typeIdSchema("node"),
  predicate: PredicateEnum,
  statement: z.string(),
  subjectLabel: z.string().nullable(),
  objectLabel: z.string().nullable(),
  sourceIds: z.array(z.string()).optional(),
});

// Define the discriminated union for search results
export const searchResultItemSchema = z.discriminatedUnion("group", [
  rerankResultItemSchema(nodeSearchResultSchema).extend({
    group: z.literal("similarNodes"),
  }),
  rerankResultItemSchema(claimSearchResultSchema).extend({
    group: z.literal("similarClaims"),
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
