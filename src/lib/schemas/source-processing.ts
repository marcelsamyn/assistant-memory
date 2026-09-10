import { typeIdSchema } from "../../types/typeid.js";
import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const sourceProcessingStatusSchema = z.enum([
  "queued",
  "processing",
  "completed",
  "failed",
  "purged",
]);
export type SourceProcessingStatus = z.infer<
  typeof sourceProcessingStatusSchema
>;

export const sourceProcessingStageSchema = z.enum(["content", "extraction"]);
export type SourceProcessingStage = z.infer<typeof sourceProcessingStageSchema>;

/** Public, privacy-safe receipt for one accepted content revision. */
export const sourceProcessingSchema = z.object({
  operationId: z.string().min(1),
  sourceId: typeIdSchema("source"),
  partitionKey: contextPartitionKeySchema.nullable(),
  status: sourceProcessingStatusSchema,
  stage: sourceProcessingStageSchema,
  sourceVersion: z.number().int().nonnegative(),
  attempt: z.number().int().nonnegative(),
  errorCode: z.string().min(1).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  completedAt: z.coerce.date().nullable(),
});
export type SourceProcessing = z.infer<typeof sourceProcessingSchema>;

export const getSourceProcessingRequestSchema = z.object({
  userId: z.string().min(1),
  partitionKey: contextPartitionKeySchema.optional(),
  operationId: z.string().min(1),
});
export type GetSourceProcessingRequest = z.infer<
  typeof getSourceProcessingRequestSchema
>;

export const getSourceProcessingResponseSchema = z.object({
  processing: sourceProcessingSchema.nullable(),
});
export type GetSourceProcessingResponse = z.infer<
  typeof getSourceProcessingResponseSchema
>;
