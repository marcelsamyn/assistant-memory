import {
  ClaimStatusEnum,
  AssertedByKindEnum,
  NodeTypeEnum,
  PredicateEnum,
  ScopeEnum,
} from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const queryGraphRequestSchema = z.object({
  userId: z.string(),
  query: z.string().optional(),
  maxNodes: z.number().int().positive().default(100),
  nodeTypes: z.array(NodeTypeEnum).optional(),
});

export const queryGraphNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  label: z.string(),
  description: z.string().nullable().optional(),
  sourceIds: z.array(z.string()).optional(),
});

export const queryGraphClaimSchema = z.object({
  id: typeIdSchema("claim"),
  subject: typeIdSchema("node"),
  object: typeIdSchema("node"),
  predicate: PredicateEnum,
  statement: z.string(),
  description: z.string().nullable().optional(),
  sourceId: typeIdSchema("source"),
  scope: ScopeEnum,
  assertedByKind: AssertedByKindEnum,
  assertedByNodeId: typeIdSchema("node").nullable(),
  statedAt: z.coerce.date(),
  status: ClaimStatusEnum,
});

export const queryGraphResponseSchema = z.object({
  nodes: z.array(queryGraphNodeSchema),
  claims: z.array(queryGraphClaimSchema),
});

export type QueryGraphRequest = z.infer<typeof queryGraphRequestSchema>;
export type QueryGraphResponse = z.infer<typeof queryGraphResponseSchema>;
