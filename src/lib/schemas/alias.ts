import { typeIdSchema } from "../../types/typeid.js";
import { z } from "zod";

const aliasTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Alias text is required",
});

export const aliasSchema = z.object({
  id: typeIdSchema("alias"),
  userId: z.string(),
  aliasText: z.string(),
  normalizedAliasText: z.string(),
  canonicalNodeId: typeIdSchema("node"),
  createdAt: z.coerce.date(),
});

export const createAliasRequestSchema = z.object({
  userId: z.string(),
  canonicalNodeId: typeIdSchema("node"),
  aliasText: aliasTextSchema,
});

export const createAliasResponseSchema = z.object({
  alias: aliasSchema,
});

export type CreateAliasRequest = z.infer<typeof createAliasRequestSchema>;
export type CreateAliasResponse = z.infer<typeof createAliasResponseSchema>;

export const deleteAliasRequestSchema = z.object({
  userId: z.string(),
  aliasId: typeIdSchema("alias"),
});

export const deleteAliasResponseSchema = z.object({
  deleted: z.literal(true),
});

export type DeleteAliasRequest = z.infer<typeof deleteAliasRequestSchema>;
export type DeleteAliasResponse = z.infer<typeof deleteAliasResponseSchema>;
