/**
 * One-off maintenance: bring an existing user-self Person node up to the
 * current identity-hygiene contract — distinguishing primary label, seeded
 * multi-token aliases, and NO ambiguous bare-first-name alias.
 *
 * Idempotent. Operates on the explicitly-passed aliases when given, else the
 * stored `userSelfAliases`.
 *
 * Note: an empty effective alias list (none stored and none passed) seeds no
 * distinguishing aliases and therefore removes ALL existing alias rows on the
 * self node — the intended clean-slate behavior for this maintenance job.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { aliases as aliasesTable } from "~/db/schema";
import { normalizeAliasText } from "~/lib/alias";
import { getUserSelfAliases } from "~/lib/user-profile";
import {
  distinguishingAliases,
  ensureUserSelfIdentity,
} from "~/lib/user-self-identity";

export interface BackfillUserSelfIdentityParams {
  db: DrizzleDB;
  userId: string;
  aliases?: string[];
}

export interface BackfillUserSelfIdentityResult {
  selfNodeId: string;
  primaryAliasesSeeded: string[];
  removedAmbiguousAliases: number;
}

export async function backfillUserSelfIdentity(
  params: BackfillUserSelfIdentityParams,
): Promise<BackfillUserSelfIdentityResult> {
  const { db, userId } = params;
  const effectiveAliases =
    params.aliases ?? (await getUserSelfAliases(db, userId));

  const selfNodeId = await ensureUserSelfIdentity(db, userId, effectiveAliases);
  const seeded = distinguishingAliases(effectiveAliases);
  const keep = new Set(seeded.map((a) => normalizeAliasText(a)));

  // Remove any previously-written single-token (ambiguous) alias rows on the
  // self node; keep only the multi-token distinguishing aliases.
  const selfAliasRows = await db
    .select({
      id: aliasesTable.id,
      normalized: aliasesTable.normalizedAliasText,
    })
    .from(aliasesTable)
    .where(
      and(
        eq(aliasesTable.userId, userId),
        eq(aliasesTable.canonicalNodeId, selfNodeId),
      ),
    );

  const toDelete = selfAliasRows.filter((row) => !keep.has(row.normalized));
  if (toDelete.length > 0) {
    await db.delete(aliasesTable).where(
      inArray(
        aliasesTable.id,
        toDelete.map((row) => row.id),
      ),
    );
  }

  return {
    selfNodeId,
    primaryAliasesSeeded: seeded,
    removedAmbiguousAliases: toDelete.length,
  };
}
