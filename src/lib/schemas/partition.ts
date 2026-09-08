/**
 * Generic opaque memory-partition contracts.
 *
 * Partition keys are owned and interpreted by the caller. Assistant Memory
 * validates their transport shape, stores them verbatim, and never infers
 * product meaning from their contents.
 */
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid.js";

export const contextPartitionKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/,
    "Partition keys may contain letters, numbers, '.', '_', ':', '@', '/', and '-'",
  )
  .brand<"ContextPartitionKey">();
export type ContextPartitionKey = z.infer<typeof contextPartitionKeySchema>;

export const partitionMigrationStateSchema = z.enum([
  "unmigrated",
  "migrating",
  "migrated",
]);
export type PartitionMigrationState = z.infer<
  typeof partitionMigrationStateSchema
>;

export const setPartitionMigrationStateRequestSchema = z
  .object({
    userId: z.string().min(1),
    expectedState: partitionMigrationStateSchema,
    expectedVersion: z.number().int().nonnegative(),
    nextState: z.enum(["migrating", "migrated"]),
    /** Caller-owned destination for evidence-free legacy nodes. */
    unassignedPartitionKey: contextPartitionKeySchema.optional(),
  })
  .superRefine((request, context) => {
    if (
      request.nextState === "migrated" &&
      request.unassignedPartitionKey === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["unassignedPartitionKey"],
        message: "An unassigned partition is required to finish migration",
      });
    }
  });
export type SetPartitionMigrationStateRequest = z.infer<
  typeof setPartitionMigrationStateRequestSchema
>;

export const setPartitionMigrationStateResponseSchema = z.object({
  state: z.enum(["migrating", "migrated"]),
  version: z.number().int().positive(),
});
export type SetPartitionMigrationStateResponse = z.infer<
  typeof setPartitionMigrationStateResponseSchema
>;

export const reclassifySourcePartitionRequestSchema = z.object({
  userId: z.string().min(1),
  sourceId: typeIdSchema("source"),
  expectedPartitionKey: contextPartitionKeySchema.nullable(),
  targetPartitionKey: contextPartitionKeySchema,
  expectedSourceVersion: z.number().int().nonnegative(),
  /** Caller-owned durable generation; retries must reuse it verbatim. */
  bindingGeneration: z.string().min(1).max(200),
});
export type ReclassifySourcePartitionRequest = z.infer<
  typeof reclassifySourcePartitionRequestSchema
>;

export const partitionNodeMappingSchema = z.object({
  sourceNodeId: typeIdSchema("node"),
  partitionKey: contextPartitionKeySchema,
  replacementNodeId: typeIdSchema("node"),
});
export type PartitionNodeMapping = z.infer<typeof partitionNodeMappingSchema>;

export const reclassifySourcePartitionResponseSchema = z.object({
  sourceId: typeIdSchema("source"),
  partitionKey: contextPartitionKeySchema,
  sourceVersion: z.number().int().positive(),
  bindingGeneration: z.string().min(1),
  replayed: z.boolean(),
  movedClaimCount: z.number().int().nonnegative(),
  nodeMappings: z.array(partitionNodeMappingSchema),
});
export type ReclassifySourcePartitionResponse = z.infer<
  typeof reclassifySourcePartitionResponseSchema
>;

export const partitionArtifactKindSchema = z.enum([
  "aliases",
  "node_embeddings",
  "redirects",
  "summary",
  "user_profile",
  "commitment_presentation",
]);
export const partitionArtifactDispositionSchema = z.enum([
  "pending",
  "rebuilt",
  "quarantined",
  "not_applicable",
]);

export const partitionProgressRequestSchema = z.object({
  userId: z.string().min(1),
  sourceId: typeIdSchema("source").optional(),
});
export type PartitionProgressRequest = z.infer<
  typeof partitionProgressRequestSchema
>;

export const partitionProgressResponseSchema = z.object({
  migration: z.object({
    state: partitionMigrationStateSchema,
    version: z.number().int().nonnegative(),
  }),
  source: z
    .object({
      sourceId: typeIdSchema("source"),
      partitionKey: contextPartitionKeySchema.nullable(),
      version: z.number().int().nonnegative(),
    })
    .nullable(),
});
export type PartitionProgressResponse = z.infer<
  typeof partitionProgressResponseSchema
>;

export const partitionInventoryRequestSchema = z.object({
  userId: z.string().min(1),
  cursor: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type PartitionInventoryRequest = z.input<
  typeof partitionInventoryRequestSchema
>;

export const partitionInventoryItemSchema = z.object({
  sourceNodeId: typeIdSchema("node"),
  partitionKey: contextPartitionKeySchema,
  replacementNodeId: typeIdSchema("node").nullable(),
  sourceId: typeIdSchema("source"),
  bindingGeneration: z.string().min(1),
  state: z.enum(["quarantined", "completed"]),
  artifacts: z.array(
    z.object({
      kind: partitionArtifactKindSchema,
      disposition: partitionArtifactDispositionSchema,
      sourceCount: z.number().int().nonnegative(),
      rebuiltCount: z.number().int().nonnegative(),
      quarantinedCount: z.number().int().nonnegative(),
    }),
  ),
});

export const partitionInventoryResponseSchema = z.object({
  items: z.array(partitionInventoryItemSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type PartitionInventoryResponse = z.infer<
  typeof partitionInventoryResponseSchema
>;
