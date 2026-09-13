/**
 * `user_profiles` helpers — read/write the typed `metadata` JSONB.
 *
 * Aliases: user profile metadata, user self aliases, transcript speaker
 * config. Phase 4 ingestion uses `getUserSelfAliases` to identify the
 * user-self speaker; the host calls `setUserSelfAliases` once per
 * configuration change.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  memoryPartitions,
  nodeMetadata,
  nodes,
  userProfiles,
} from "~/db/schema";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
import {
  userProfileMetadataSchema,
  type UserProfileMetadata,
} from "~/lib/schemas/user-profile-metadata";
import {
  ensureUserSelfIdentity,
  lockUserSelfIdentity,
} from "~/lib/user-self-identity";
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
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
): Promise<{ aliases: string[] }> {
  // Validate via the metadata schema — same path the read takes, so an
  // alias that survives the writer round-trips through the reader cleanly.
  const parsed = userProfileMetadataSchema.parse({
    userSelfAliases: aliases,
  });
  const nextAliases = parsed.userSelfAliases;

  // Keep the profile and graph identity update in one transaction. Identity
  // validation can fail after it resolves the profile row (for example when
  // the requested partition is no longer active); committing the profile
  // first would leave configuration and the self node out of sync.
  await db.transaction(async (tx) => {
    await lockUserSelfIdentity(tx, userId);
    const existing = await readMetadata(tx, userId);
    if (existing === null) {
      await tx.insert(userProfiles).values({
        id: newTypeId("user_profile"),
        userId,
        content: "",
        metadata: { ...parsed, userSelfAliases: nextAliases },
      });
    } else {
      // Merge: replace `userSelfAliases`, preserve catchall keys.
      const nextMetadata: UserProfileMetadata = {
        ...existing,
        userSelfAliases: nextAliases,
      };
      await tx
        .update(userProfiles)
        .set({ metadata: nextMetadata, lastUpdatedAt: sql`now()` })
        .where(eq(userProfiles.userId, userId));
    }

    if (accessScope === "workspace" && partitionKey === undefined) {
      const activeSelfRows = await tx
        .select({ id: nodes.id, partitionKey: nodes.partitionKey })
        .from(nodes)
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(
            eq(nodes.userId, userId),
            eq(nodes.nodeType, "Person"),
            sql`${nodes.partitionKey} IS NOT NULL`,
            sql`${nodeMetadata.additionalData}->>'isUserSelf' = 'true'`,
            sql`EXISTS (
              SELECT 1
              FROM ${memoryPartitions} AS active_partition
              WHERE active_partition.user_id = ${userId}
                AND active_partition.partition_key = ${nodes.partitionKey}
                AND active_partition.status = 'active'
            )`,
          ),
        )
        .orderBy(nodes.partitionKey, nodes.id);

      if (activeSelfRows.length > 0) {
        for (const row of activeSelfRows) {
          await ensureUserSelfIdentity(
            tx,
            userId,
            nextAliases,
            row.partitionKey ?? undefined,
            "partition",
            row.id,
          );
        }
      } else {
        // Preserve the legacy path before migration and let the existing
        // helper create only memory:personal after migration.
        await ensureUserSelfIdentity(
          tx,
          userId,
          nextAliases,
          undefined,
          "workspace",
        );
      }
    } else {
      await ensureUserSelfIdentity(
        tx,
        userId,
        nextAliases,
        partitionKey,
        accessScope,
      );
    }
  });

  return { aliases: nextAliases };
}
