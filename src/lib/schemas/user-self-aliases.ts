/**
 * Request/response shapes for `POST /user/self-aliases`.
 *
 * Used by transcript ingestion (Phase 4 PR 4ii-b) to resolve the user-self
 * speaker label. The handler replaces the full list — there is no
 * add/remove granularity by design.
 */
import { z } from "zod";

export const setUserSelfAliasesRequestSchema = z.object({
  userId: z.string().min(1),
  aliases: z.array(z.string().min(1)),
});

export const setUserSelfAliasesResponseSchema = z.object({
  aliases: z.array(z.string().min(1)),
});

export type SetUserSelfAliasesRequest = z.infer<
  typeof setUserSelfAliasesRequestSchema
>;
export type SetUserSelfAliasesResponse = z.infer<
  typeof setUserSelfAliasesResponseSchema
>;
