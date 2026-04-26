import {
  AssertedByKindEnum,
  ClaimStatusEnum,
  PredicateEnum,
  ScopeEnum,
} from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

const claimObjectSchema = z
  .object({
    objectNodeId: typeIdSchema("node").optional(),
    objectValue: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      (value.objectNodeId === undefined) !== (value.objectValue === undefined),
    {
      message: "Exactly one of objectNodeId or objectValue is required",
    },
  );

export const claimSchema = z.object({
  id: typeIdSchema("claim"),
  userId: z.string(),
  subjectNodeId: typeIdSchema("node"),
  objectNodeId: typeIdSchema("node").nullable(),
  objectValue: z.string().nullable(),
  predicate: PredicateEnum,
  statement: z.string(),
  description: z.string().nullable(),
  sourceId: typeIdSchema("source"),
  scope: ScopeEnum,
  assertedByKind: AssertedByKindEnum,
  assertedByNodeId: typeIdSchema("node").nullable(),
  supersededByClaimId: typeIdSchema("claim").nullable(),
  contradictedByClaimId: typeIdSchema("claim").nullable(),
  statedAt: z.coerce.date(),
  validFrom: z.coerce.date().nullable(),
  validTo: z.coerce.date().nullable(),
  status: ClaimStatusEnum,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const createClaimRequestSchema = z
  .object({
    userId: z.string(),
    subjectNodeId: typeIdSchema("node"),
    predicate: PredicateEnum,
    statement: z.string().min(1),
    sourceId: typeIdSchema("source").optional(),
    description: z.string().optional(),
    statedAt: z.coerce.date().optional(),
    validFrom: z.coerce.date().optional(),
    validTo: z.coerce.date().optional(),
  })
  .and(claimObjectSchema);

export const claimResponseSchema = z.object({
  claim: claimSchema,
});

export const createClaimResponseSchema = claimResponseSchema;

export type CreateClaimRequest = z.infer<typeof createClaimRequestSchema>;
export type CreateClaimResponse = z.infer<typeof createClaimResponseSchema>;

export const deleteClaimRequestSchema = z.object({
  userId: z.string(),
  claimId: typeIdSchema("claim"),
});

export const deleteClaimResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteClaimRequest = z.infer<typeof deleteClaimRequestSchema>;
export type DeleteClaimResponse = z.infer<typeof deleteClaimResponseSchema>;

export const updateClaimRequestSchema = z.object({
  userId: z.string(),
  claimId: typeIdSchema("claim"),
  status: z.literal(ClaimStatusEnum.enum.retracted),
});

export const updateClaimResponseSchema = claimResponseSchema;

export type UpdateClaimRequest = z.infer<typeof updateClaimRequestSchema>;
export type UpdateClaimResponse = z.infer<typeof updateClaimResponseSchema>;
