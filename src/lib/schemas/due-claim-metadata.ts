import { z } from "zod";
import { isValidTimeZone } from "~/lib/time-zone.js";

/** 24-hour wall-clock time, `HH:mm`. Common aliases: due time, time of day. */
export const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Shape of a time-qualified `DUE_ON` claim's `metadata` jsonb: the canonical
 * human truth (local wall-clock time + IANA zone). The resolved UTC instant is
 * stored separately in `claims.object_instant`. Parsed defensively on read; a
 * claim with absent/invalid metadata is treated as date-only.
 */
export const dueClaimMetadataSchema = z.object({
  dueTime: z.string().regex(DUE_TIME_PATTERN, "dueTime must be HH:mm"),
  timeZone: z.string().refine(isValidTimeZone, "Invalid IANA time zone"),
});

export type DueClaimMetadata = z.infer<typeof dueClaimMetadataSchema>;
