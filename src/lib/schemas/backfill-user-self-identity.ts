import { z } from "zod";

export const backfillUserSelfIdentityRequestSchema = z.object({
  userId: z.string().min(1),
  /** When omitted, the stored `userSelfAliases` are used. */
  aliases: z.array(z.string().min(1)).optional(),
});

export const backfillUserSelfIdentityResponseSchema = z.object({
  selfNodeId: z.string(),
  primaryAliasesSeeded: z.array(z.string()),
  removedAmbiguousAliases: z.number().int().nonnegative(),
});
