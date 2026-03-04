import { z } from "zod";

export const scratchpadReadRequestSchema = z.object({
  userId: z.string(),
});

export const scratchpadWriteRequestSchema = z.object({
  userId: z.string(),
  content: z.string(),
  mode: z.enum(["overwrite", "append"]).default("overwrite"),
});

export const scratchpadEditRequestSchema = z.object({
  userId: z.string(),
  oldText: z.string().min(1),
  newText: z.string(),
});

export const scratchpadResponseSchema = z.object({
  content: z.string(),
  updatedAt: z.coerce.date(),
});

export const scratchpadEditResponseSchema = scratchpadResponseSchema.extend({
  applied: z.boolean(),
  message: z.string().optional(),
});

export type ScratchpadReadRequest = z.infer<typeof scratchpadReadRequestSchema>;
export type ScratchpadWriteRequest = z.infer<
  typeof scratchpadWriteRequestSchema
>;
export type ScratchpadEditRequest = z.infer<typeof scratchpadEditRequestSchema>;
export type ScratchpadResponse = z.infer<typeof scratchpadResponseSchema>;
export type ScratchpadEditResponse = z.infer<
  typeof scratchpadEditResponseSchema
>;
