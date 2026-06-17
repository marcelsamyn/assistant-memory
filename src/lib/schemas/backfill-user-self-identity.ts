import { z } from "zod";

export const backfillUserSelfIdentityRequestSchema = z.object({
  userId: z.string().min(1),
  /**
   * When omitted, the stored `userSelfAliases` are used. Destructive edge: if
   * the effective list (passed or stored) is empty, the self node's existing
   * alias rows are ALL removed (clean-slate hygiene) — pass a non-empty list to
   * avoid clearing them.
   */
  aliases: z.array(z.string().min(1)).optional(),
});

export type BackfillUserSelfIdentityRequest = z.infer<
  typeof backfillUserSelfIdentityRequestSchema
>;

export const backfillUserSelfIdentityResponseSchema = z.object({
  selfNodeId: z.string(),
  primaryAliasesSeeded: z.array(z.string()),
  removedAmbiguousAliases: z.number().int().nonnegative(),
});

export type BackfillUserSelfIdentityResponse = z.infer<
  typeof backfillUserSelfIdentityResponseSchema
>;
