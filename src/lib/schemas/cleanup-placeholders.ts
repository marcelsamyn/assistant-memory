/**
 * REST/SDK schemas for `POST /maintenance/cleanup-placeholders`. The job is
 * surfacing-only by default; pass `triggerCleanup: true` to also enqueue an
 * iterative cleanup job seeded with the surfaced placeholder ids.
 */
import { z } from "zod";
import { typeIdSchema } from "~/types/typeid";

export const cleanupPlaceholdersRequestSchema = z.object({
  userId: z.string().startsWith("user_"),
  olderThanDays: z.number().int().positive().default(7),
  limit: z.number().int().positive().max(500).default(50),
  /**
   * When true, also enqueues `cleanup-graph` with the surfaced placeholder
   * ids as `seedIds`. The cleanup pipeline (LLM-driven) decides what to
   * merge/retract/contradict.
   */
  triggerCleanup: z.boolean().default(false),
});

export type CleanupPlaceholdersRequest = z.infer<
  typeof cleanupPlaceholdersRequestSchema
>;

export const cleanupPlaceholdersResponseSchema = z.object({
  placeholderCount: z.number().int().nonnegative(),
  candidatesFound: z.number().int().nonnegative(),
  placeholders: z.array(
    z.object({
      id: typeIdSchema("node"),
      label: z.string(),
      candidates: z.array(
        z.object({
          id: typeIdSchema("node"),
          label: z.string(),
          score: z.number().optional(),
        }),
      ),
    }),
  ),
  seededCleanupJob: z.boolean(),
  jobId: z.string().optional(),
});

export type CleanupPlaceholdersResponse = z.infer<
  typeof cleanupPlaceholdersResponseSchema
>;
