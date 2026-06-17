/**
 * User-self Person node identity management.
 *
 * Centralizes everything about the account owner's own Person node: lazy
 * creation (advisory-lock-guarded), naming it with a distinguishing label,
 * and seeding only unambiguous (multi-token) aliases into the global alias
 * table used by `resolveIdentity`. Bare first names are deliberately kept out
 * of the alias table so a same-named contact can never be merged into the
 * user (or vice versa) on a single-token match. Also builds the "who the user
 * is" note injected into document/conversation extraction prompts.
 *
 * Common aliases: user self node, self identity, primary self label,
 * distinguishing aliases, user identity prompt note, isUserSelf.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes } from "~/db/schema";
import { createAlias } from "~/lib/alias";
import { normalizeLabel } from "~/lib/label";
import type { TypeId } from "~/types/typeid";

/** Count whitespace-separated tokens in an alias (after trimming). */
function tokenCount(alias: string): number {
  return alias
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0).length;
}

/**
 * Aliases safe to write to the global alias table and to use as a node label:
 * multi-token only, de-duplicated by normalized form. Single-token names
 * (e.g. "Marcel") are inherently ambiguous and are intentionally excluded.
 */
export function distinguishingAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const alias of aliases) {
    const trimmed = alias.trim();
    if (tokenCount(trimmed) < 2) continue;
    const key = normalizeLabel(trimmed);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

/**
 * Pick the most-specific distinguishing alias to use as the self node's
 * primary label: most tokens, then longest string. Returns null when no
 * multi-token alias is available, so the node keeps its existing label rather
 * than being downgraded to an ambiguous single-token name.
 */
export function selectPrimarySelfLabel(aliases: string[]): string | null {
  const candidates = distinguishingAliases(aliases);
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    const bestTokens = tokenCount(best);
    const currentTokens = tokenCount(current);
    if (currentTokens > bestTokens) return current;
    if (currentTokens === bestTokens && current.length > best.length) {
      return current;
    }
    return best;
  });
}

/**
 * Build the "who the user is" note injected into document/conversation
 * extraction prompts. Returns null when no aliases are configured so callers
 * can omit the section entirely.
 */
export function buildUserIdentityNote(aliases: string[]): string | null {
  const cleaned = aliases.map((a) => a.trim()).filter((a) => a.length > 0);
  if (cleaned.length === 0) return null;
  const primary = selectPrimarySelfLabel(cleaned) ?? cleaned[0]!;
  const seen = new Set<string>();
  const aliasList = cleaned
    .filter((a) => {
      const key = normalizeLabel(a);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(", ");
  return `About the user: the account owner is "${primary}" (also referred to as: ${aliasList}). When the content refers to the user by name, use their most specific name as the node label. Do NOT merge a different person who happens to share a first name with the user, and never attribute a same-named other person's statements to the user.`;
}

/**
 * Ensure the user's own Person node exists, returning its id. Looked up by
 * `nodeMetadata.additionalData.isUserSelf = true`; created lazily on first use.
 *
 * Concurrency: serialized per-user via a transaction-scoped Postgres advisory
 * lock keyed on `hashtext('user_self_person:' || userId)`. Two concurrent
 * callers for the same user queue at the lock and observe each other's INSERT,
 * so only one user-self Person row is ever created. The lock releases
 * automatically at transaction commit.
 */
export async function ensureUserSelfPersonNode(
  db: DrizzleDB,
  userId: string,
): Promise<TypeId<"node">> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${"user_self_person:" + userId}))`,
    );

    const existing = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          eq(nodes.nodeType, "Person"),
          sql`${nodeMetadata.additionalData}->>'isUserSelf' = 'true'`,
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id;

    const [newNode] = await tx
      .insert(nodes)
      .values({ userId, nodeType: "Person" })
      .returning();
    if (!newNode) {
      throw new Error(`Failed to create user-self Person node for ${userId}`);
    }
    await tx.insert(nodeMetadata).values({
      nodeId: newNode.id,
      label: userId,
      canonicalLabel: normalizeLabel(userId),
      additionalData: { isUserSelf: true },
    });
    return newNode.id;
  });
}

/**
 * Ensure the user-self Person node exists, carries a distinguishing primary
 * label, and has the user's multi-token aliases seeded into the alias table.
 * Single-token (ambiguous) aliases are deliberately NOT written to the alias
 * table — they remain usable for transcript speaker matching via the
 * `userSelfAliases` config set, but must never drive an identity merge.
 *
 * Idempotent: safe to call on every transcript ingest and every config write.
 */
export async function ensureUserSelfIdentity(
  db: DrizzleDB,
  userId: string,
  aliases: string[],
): Promise<TypeId<"node">> {
  const nodeId = await ensureUserSelfPersonNode(db, userId);

  const primaryLabel = selectPrimarySelfLabel(aliases);
  if (primaryLabel) {
    // Read-before-write: this runs on every transcript ingest, where the label
    // is almost always already correct. Skip the UPDATE when unchanged to avoid
    // needless WAL/MVCC churn on the hot path.
    const [current] = await db
      .select({ label: nodeMetadata.label })
      .from(nodeMetadata)
      .where(eq(nodeMetadata.nodeId, nodeId))
      .limit(1);
    if (current?.label !== primaryLabel) {
      await db
        .update(nodeMetadata)
        .set({
          label: primaryLabel,
          canonicalLabel: normalizeLabel(primaryLabel),
        })
        .where(eq(nodeMetadata.nodeId, nodeId));
    }
  }

  await Promise.all(
    distinguishingAliases(aliases).map((alias) =>
      createAlias(db, { userId, canonicalNodeId: nodeId, aliasText: alias }),
    ),
  );

  return nodeId;
}
