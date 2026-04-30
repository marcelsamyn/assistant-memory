/**
 * Shape of the `user_profiles.metadata` JSONB column.
 *
 * Currently carries `userSelfAliases` (Phase 4 transcript ingestion uses these
 * to resolve the user-self speaker to `assertedByKind = 'user'`). The
 * `catchall` keeps the column extensible for future Phase 4 fields without
 * forcing a migration per addition.
 */
import { z } from "zod";

export const userProfileMetadataSchema = z
  .object({
    userSelfAliases: z.array(z.string().min(1)).default([]),
  })
  .catchall(z.unknown());

export type UserProfileMetadata = z.infer<typeof userProfileMetadataSchema>;
