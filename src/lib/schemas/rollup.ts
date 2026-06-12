import { z } from "zod";

export const rollupRequestSchema = z.object({
  userId: z.string().min(1),
  /** Hard cap on LLM calls this sweep; leftovers resume on the next call. */
  maxLlmCalls: z.number().int().positive().max(500).default(50),
  /**
   * History floor (yyyy-MM-dd). Periods ending before this are excluded
   * outright — never summarized, purged from pending. Prevents a first
   * sweep over a backlogged account from paying for ancient history.
   */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be yyyy-MM-dd")
    .optional(),
});

export type RollupRequest = z.input<typeof rollupRequestSchema>;

export const rollupResponseSchema = z.object({
  message: z.string(),
  enqueued: z.boolean(),
});

export type RollupResponse = z.infer<typeof rollupResponseSchema>;
