import { EdgeTypeEnum, NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

// --- Get Node ---

export const getNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
});

export const getNodeEdgeSchema = z.object({
  id: typeIdSchema("edge"),
  sourceNodeId: typeIdSchema("node"),
  targetNodeId: typeIdSchema("node"),
  edgeType: EdgeTypeEnum,
  description: z.string().nullable(),
  sourceLabel: z.string().nullable(),
  targetLabel: z.string().nullable(),
});

export const getNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string().nullable(),
    description: z.string().nullable(),
    createdAt: z.coerce.date(),
    sourceIds: z.array(z.string()),
  }),
  edges: z.array(getNodeEdgeSchema),
});

export type GetNodeRequest = z.infer<typeof getNodeRequestSchema>;
export type GetNodeResponse = z.infer<typeof getNodeResponseSchema>;

// --- Get Node Sources ---

export const getNodeSourcesRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
});

export const nodeSourceSchema = z.object({
  sourceId: z.string(),
  type: z.string(),
  content: z.string().nullable(),
  timestamp: z.coerce.date().nullable(),
});

export const getNodeSourcesResponseSchema = z.object({
  sources: z.array(nodeSourceSchema),
});

export type GetNodeSourcesRequest = z.infer<
  typeof getNodeSourcesRequestSchema
>;
export type GetNodeSourcesResponse = z.infer<
  typeof getNodeSourcesResponseSchema
>;

// --- Update Node ---

export const updateNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
  label: z.string().optional(),
  description: z.string().optional(),
  nodeType: NodeTypeEnum.optional(),
});

export const updateNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string().nullable(),
    description: z.string().nullable(),
  }),
});

export type UpdateNodeRequest = z.infer<typeof updateNodeRequestSchema>;
export type UpdateNodeResponse = z.infer<typeof updateNodeResponseSchema>;

// --- Delete Node ---

export const deleteNodeRequestSchema = z.object({
  userId: z.string(),
  nodeId: typeIdSchema("node"),
});

export const deleteNodeResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteNodeRequest = z.infer<typeof deleteNodeRequestSchema>;
export type DeleteNodeResponse = z.infer<typeof deleteNodeResponseSchema>;

// --- Create Node ---

export const createNodeRequestSchema = z.object({
  userId: z.string(),
  nodeType: NodeTypeEnum,
  label: z.string().min(1),
  description: z.string().optional(),
});

export const createNodeResponseSchema = z.object({
  node: z.object({
    id: typeIdSchema("node"),
    nodeType: NodeTypeEnum,
    label: z.string(),
    description: z.string().nullable(),
  }),
});

export type CreateNodeRequest = z.infer<typeof createNodeRequestSchema>;
export type CreateNodeResponse = z.infer<typeof createNodeResponseSchema>;
