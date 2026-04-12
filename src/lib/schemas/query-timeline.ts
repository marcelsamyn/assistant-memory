import { EdgeTypeEnum, NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const queryTimelineRequestSchema = z.object({
  userId: z.string(),
  startDate: z
    .string()
    .regex(dateRegex, "startDate must be in YYYY-MM-DD format")
    .optional(),
  endDate: z
    .string()
    .regex(dateRegex, "endDate must be in YYYY-MM-DD format")
    .optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
  nodeTypes: z.array(NodeTypeEnum).optional(),
});

export const queryTimelineNodeSchema = z.object({
  id: typeIdSchema("node"),
  label: z.string().nullable(),
  description: z.string().nullable(),
  nodeType: NodeTypeEnum,
  edgeType: EdgeTypeEnum,
  createdAt: z.coerce.date(),
});

export const queryTimelineDaySchema = z.object({
  date: z.string(),
  temporalNodeId: typeIdSchema("node"),
  nodeCount: z.number(),
  nodes: z.array(queryTimelineNodeSchema),
});

export const queryTimelineResponseSchema = z.object({
  days: z.array(queryTimelineDaySchema),
  totalDays: z.number(),
  hasMore: z.boolean(),
});

export type QueryTimelineRequest = z.infer<typeof queryTimelineRequestSchema>;
export type QueryTimelineResponse = z.infer<typeof queryTimelineResponseSchema>;
