/** Map a joined DUE_ON claim's metadata + object_instant into read-model fields. */
import { dueClaimMetadataSchema } from "~/lib/schemas/due-claim-metadata";

export interface DueQualifierFields {
  dueTime: string | null;
  timeZone: string | null;
  dueAt: Date | null;
}

/**
 * Parse a DUE_ON claim's `metadata` jsonb defensively. Malformed/absent metadata
 * degrades to date-only (`dueTime`/`timeZone` null) — a single bad row must not
 * 500 a read (mirrors `coerceTaskStatus`). `dueAt` comes straight from the
 * indexed `object_instant` column.
 */
export function readDueQualifier(
  metadata: unknown,
  objectInstant: Date | null,
): DueQualifierFields {
  const parsed = dueClaimMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    if (metadata != null) {
      console.warn(`Ignoring malformed DUE_ON metadata: ${JSON.stringify(metadata)}`);
    }
    return { dueTime: null, timeZone: null, dueAt: objectInstant ?? null };
  }
  return { dueTime: parsed.data.dueTime, timeZone: parsed.data.timeZone, dueAt: objectInstant ?? null };
}
