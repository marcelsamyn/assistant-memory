import { NodeTypeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const queryNodeTypeRequestSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  types: z.array(NodeTypeEnum),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  includeFormattedResult: z.boolean().default(true),
});

export const queryNodeTypeResponseNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  metadata: z.object({
    label: z.string(),
    description: z.string().optional(),
  }),
});

export const queryNodeTypeResponseSchema = z.object({
  date: z.string(),
  types: z.array(NodeTypeEnum),
  nodeCount: z.number().optional(),
  formattedResult: z.string().optional(),
  nodes: z.array(queryNodeTypeResponseNodeSchema),
  error: z.string().optional(), // To handle early return for no day node
});

export type QueryNodeTypeRequest = z.infer<typeof queryNodeTypeRequestSchema>;
export type QueryNodeTypeResponse = z.infer<typeof queryNodeTypeResponseSchema>;
