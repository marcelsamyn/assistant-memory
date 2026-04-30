/**
 * `user_profiles` helpers — read/write the typed `metadata` JSONB.
 *
 * Aliases: user profile metadata, user self aliases, transcript speaker
 * config. Phase 4 ingestion uses `getUserSelfAliases` to identify the
 * user-self speaker; the host calls `setUserSelfAliases` once per
 * configuration change.
 */
import { eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { userProfiles } from "~/db/schema";
import {
  userProfileMetadataSchema,
  type UserProfileMetadata,
} from "~/lib/schemas/user-profile-metadata";
import { newTypeId } from "~/types/typeid";

/** Read `metadata` and parse with the schema. Empty/absent row → empty default. */
async function readMetadata(
  db: DrizzleDB,
  userId: string,
): Promise<UserProfileMetadata | null> {
  const [row] = await db
    .select({ metadata: userProfiles.metadata })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  if (!row) return null;
  return userProfileMetadataSchema.parse(row.metadata ?? {});
}

/**
 * Returns the user's self-aliases (labels they appear under in transcripts).
 * Returns `[]` if no profile row exists yet — callers may set aliases before
 * the user has any other profile content.
 */
export async function getUserSelfAliases(
  db: DrizzleDB,
  userId: string,
): Promise<string[]> {
  const metadata = await readMetadata(db, userId);
  return metadata?.userSelfAliases ?? [];
}

/**
 * Replaces the full `userSelfAliases` list. Preserves any other
 * (catchall) keys already on `metadata`. Creates the `user_profiles` row
 * with empty `content` if none exists yet.
 */
export async function setUserSelfAliases(
  db: DrizzleDB,
  userId: string,
  aliases: string[],
): Promise<{ aliases: string[] }> {
  // Validate via the metadata schema — same path the read takes, so an
  // alias that survives the writer round-trips through the reader cleanly.
  const parsed = userProfileMetadataSchema.parse({
    userSelfAliases: aliases,
  });
  const nextAliases = parsed.userSelfAliases;

  const existing = await readMetadata(db, userId);
  if (existing === null) {
    await db.insert(userProfiles).values({
      id: newTypeId("user_profile"),
      userId,
      content: "",
      metadata: { ...parsed, userSelfAliases: nextAliases },
    });
    return { aliases: nextAliases };
  }

  // Merge: replace `userSelfAliases`, preserve catchall keys.
  const nextMetadata: UserProfileMetadata = {
    ...existing,
    userSelfAliases: nextAliases,
  };
  await db
    .update(userProfiles)
    .set({ metadata: nextMetadata, lastUpdatedAt: sql`now()` })
    .where(eq(userProfiles.userId, userId));

  return { aliases: nextAliases };
}
