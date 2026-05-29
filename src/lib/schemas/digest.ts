/**
 * Request/response schemas for `POST /digest` — the consolidated daily
 * rollup that bundles open commitments (bucketed by due date), metric
 * movers, what's-new, and the pinned-context subset a "Today" view needs,
 * so consumers render a digest from one call.
 *
 * Structured data only: narrative prose is generated consumer-side.
 */
import { z } from "zod";
import { contextBundleSchema } from "~/lib/context/types.js";
import { isValidTimeZone } from "~/lib/digest/time-zone.js";
import { metricMoverSchema } from "~/lib/schemas/metric-movers.js";
import { openCommitmentSchema } from "~/lib/schemas/open-commitments.js";
import { queryRecentChangesResponseSchema } from "~/lib/schemas/query-recent-changes.js";

export const getDigestRequestSchema = z.object({
  userId: z.string().min(1),
  /** The digest's calendar day (the caller's local "today"). */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  /** IANA zone used to resolve the default `since` cursor for what's-new. */
  timeZone: z.string().min(1).refine(isValidTimeZone, "Invalid IANA time zone"),
  /** What's-new lower bound; defaults to the start of `date` in `timeZone`. */
  since: z.string().datetime().pipe(z.coerce.date()).optional(),
  /** Horizon for the `upcoming` commitments bucket (default 7 days). */
  upcomingWithinDays: z.number().int().min(0).max(365).optional(),
  /** Cap the metric movers list to the top-N by magnitude. */
  metricMoverLimit: z.number().int().positive().max(100).optional(),
  /** Cap each what's-new collection. */
  whatsNewLimit: z.number().int().positive().max(200).optional(),
  /** Include the pinned/preferences context subset (default true). */
  includePinned: z.boolean().optional(),
});
export type GetDigestRequest = z.infer<typeof getDigestRequestSchema>;

export const digestCommitmentsSchema = z.object({
  dueToday: z.array(openCommitmentSchema),
  overdue: z.array(openCommitmentSchema),
  upcoming: z.array(openCommitmentSchema),
});
export type DigestCommitments = z.infer<typeof digestCommitmentsSchema>;

export const getDigestResponseSchema = z.object({
  date: z.string(),
  timeZone: z.string(),
  /** The resolved what's-new lower bound actually used. */
  since: z.coerce.date(),
  generatedAt: z.coerce.date(),
  commitments: digestCommitmentsSchema,
  metricMovers: z.array(metricMoverSchema),
  whatsNew: queryRecentChangesResponseSchema,
  pinned: contextBundleSchema.optional(),
});
export type GetDigestResponse = z.infer<typeof getDigestResponseSchema>;
