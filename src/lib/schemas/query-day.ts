import { NodeTypeEnum, PredicateEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

export const queryDayRequestSchema = z.object({
  userId: z.string(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  includeFormattedResult: z.boolean().default(true),
});

export const queryDayResponseNodeSchema = z.object({
  id: typeIdSchema("node"),
  nodeType: NodeTypeEnum,
  metadata: z.object({
    label: z.string().nullable(),
    description: z.string().nullable(),
  }),
  predicate: PredicateEnum,
});

export const queryDayResponseSchema = z.object({
  date: z.string(),
  nodeCount: z.number().optional(),
  formattedResult: z.string().optional(),
  nodes: z.array(queryDayResponseNodeSchema),
  error: z.string().optional(), // Added to handle the early return case
});

export type QueryDayRequest = z.infer<typeof queryDayRequestSchema>;
export type QueryDayResponse = z.infer<typeof queryDayResponseSchema>;
