import { EdgeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

// --- Create Edge ---

export const createEdgeRequestSchema = z.object({
  userId: z.string(),
  sourceNodeId: typeIdSchema("node"),
  targetNodeId: typeIdSchema("node"),
  edgeType: EdgeTypeEnum,
  description: z.string().optional(),
});

export const edgeResponseSchema = z.object({
  edge: z.object({
    id: typeIdSchema("edge"),
    sourceNodeId: typeIdSchema("node"),
    targetNodeId: typeIdSchema("node"),
    edgeType: EdgeTypeEnum,
    description: z.string().nullable(),
  }),
});

export const createEdgeResponseSchema = edgeResponseSchema;

export type CreateEdgeRequest = z.infer<typeof createEdgeRequestSchema>;
export type CreateEdgeResponse = z.infer<typeof createEdgeResponseSchema>;

// --- Delete Edge ---

export const deleteEdgeRequestSchema = z.object({
  userId: z.string(),
  edgeId: typeIdSchema("edge"),
});

export const deleteEdgeResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteEdgeRequest = z.infer<typeof deleteEdgeRequestSchema>;
export type DeleteEdgeResponse = z.infer<typeof deleteEdgeResponseSchema>;

// --- Update Edge ---

export const updateEdgeRequestSchema = z.object({
  userId: z.string(),
  edgeId: typeIdSchema("edge"),
  edgeType: EdgeTypeEnum.optional(),
  description: z.string().optional(),
  sourceNodeId: typeIdSchema("node").optional(),
  targetNodeId: typeIdSchema("node").optional(),
});

export const updateEdgeResponseSchema = edgeResponseSchema;

export type UpdateEdgeRequest = z.infer<typeof updateEdgeRequestSchema>;
export type UpdateEdgeResponse = z.infer<typeof updateEdgeResponseSchema>;
