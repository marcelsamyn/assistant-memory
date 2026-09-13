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
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeMetadata, nodes, userProfiles } from "~/db/schema";
import { createAlias } from "~/lib/alias";
import { normalizeLabel } from "~/lib/label";
import {
  ensurePersonalPartition,
  partitionAccessCondition,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
import { userProfileMetadataSchema } from "~/lib/schemas/user-profile-metadata";
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
 * Serialize every self-identity read, create, and update for one user.
 *
 * The lock is transaction-scoped so a profile setter can hold it across its
 * profile write and all exact self-node updates. Lazy ingestion uses the same
 * key, which prevents a stale profile read from overwriting a newer one.
 */
export async function lockUserSelfIdentity(
  db: Pick<DrizzleDB, "execute">,
  userId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`user_self_identity:${userId}`}))`,
  );
}

async function readStoredUserSelfAliases(
  db: DrizzleDB,
  userId: string,
): Promise<string[]> {
  const [row] = await db
    .select({ metadata: userProfiles.metadata })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return userProfileMetadataSchema.parse(row?.metadata ?? {}).userSelfAliases;
}

interface ResolvedSelfNode {
  id: TypeId<"node">;
  partitionKey: ContextPartitionKey | undefined;
  created: boolean;
}

async function resolveUserSelfPersonNode(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope,
  requestedNodeId?: TypeId<"node">,
): Promise<ResolvedSelfNode> {
  let effectivePartitionKey = partitionKey;
  if (requestedNodeId !== undefined && partitionKey === undefined) {
    throw new Error("An exact user-self node requires its partition");
  }

  if (accessScope === "workspace" && partitionKey === undefined) {
    const [existing] = await db
      .select({ id: nodes.id, partitionKey: nodes.partitionKey })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          eq(nodes.nodeType, "Person"),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            undefined,
            accessScope,
          ),
          sql`${nodeMetadata.additionalData}->>'isUserSelf' = 'true'`,
        ),
      )
      .orderBy(asc(nodes.partitionKey), asc(nodes.id))
      .limit(1);
    effectivePartitionKey = existing?.partitionKey ?? undefined;
    if (!existing) {
      effectivePartitionKey = await ensurePersonalPartition(db, userId);
    }
  }

  await preparePartitionWrite(db, userId, effectivePartitionKey);

  const existing = await db
    .select({ id: nodes.id, partitionKey: nodes.partitionKey })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, "Person"),
        requestedNodeId !== undefined
          ? and(
              eq(nodes.id, requestedNodeId),
              effectivePartitionKey === undefined
                ? isNull(nodes.partitionKey)
                : eq(nodes.partitionKey, effectivePartitionKey),
            )
          : effectivePartitionKey === undefined
            ? isNull(nodes.partitionKey)
            : eq(nodes.partitionKey, effectivePartitionKey),
        sql`${nodeMetadata.additionalData}->>'isUserSelf' = 'true'`,
      ),
    )
    .orderBy(asc(nodes.id))
    .limit(1);
  if (existing[0]) {
    return {
      id: existing[0].id,
      partitionKey: existing[0].partitionKey ?? undefined,
      created: false,
    };
  }

  if (requestedNodeId !== undefined) {
    throw new Error(`User-self Person node ${requestedNodeId} was not found`);
  }

  const [newNode] = await db
    .insert(nodes)
    .values({
      userId,
      partitionKey: effectivePartitionKey,
      nodeType: "Person",
    })
    .returning({ id: nodes.id, partitionKey: nodes.partitionKey });
  if (!newNode) {
    throw new Error(`Failed to create user-self Person node for ${userId}`);
  }
  await db.insert(nodeMetadata).values({
    nodeId: newNode.id,
    label: userId,
    canonicalLabel: normalizeLabel(userId),
    additionalData: { isUserSelf: true },
  });
  return {
    id: newNode.id,
    partitionKey: newNode.partitionKey ?? undefined,
    created: true,
  };
}

async function applyUserSelfIdentityToNode(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
  aliases: string[],
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope,
): Promise<void> {
  const primaryLabel = selectPrimarySelfLabel(aliases);
  if (primaryLabel) {
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

  for (const alias of distinguishingAliases(aliases)) {
    await createAlias(db, {
      userId,
      partitionKey,
      canonicalNodeId: nodeId,
      aliasText: alias,
      accessScope,
    });
  }
}

/**
 * Ensure the user's own Person node exists, returning its id. Looked up by
 * `nodeMetadata.additionalData.isUserSelf = true`; created lazily on first use.
 *
 * Concurrency: serialized per-user via the transaction-scoped
 * `lockUserSelfIdentity` advisory lock. The lock is held across resolution,
 * creation, and profile-alias synchronization, then releases at commit.
 */
export async function ensureUserSelfPersonNode(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
): Promise<TypeId<"node">> {
  return db.transaction(async (tx) => {
    await lockUserSelfIdentity(tx, userId);
    const resolved = await resolveUserSelfPersonNode(
      tx,
      userId,
      partitionKey,
      accessScope,
    );
    // A direct lazy-node caller may follow an explicit per-request alias
    // override. Initialize only a newly-created node from the current stored
    // profile; existing nodes are updated by the caller's intentional path.
    if (resolved.created) {
      await applyUserSelfIdentityToNode(
        tx,
        userId,
        resolved.id,
        await readStoredUserSelfAliases(tx, userId),
        resolved.partitionKey,
        "partition",
      );
    }
    return resolved.id;
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
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
  existingNodeId?: TypeId<"node">,
): Promise<TypeId<"node">> {
  return db.transaction(async (tx) => {
    await lockUserSelfIdentity(tx, userId);
    const resolved = await resolveUserSelfPersonNode(
      tx,
      userId,
      partitionKey,
      accessScope,
      existingNodeId,
    );
    await applyUserSelfIdentityToNode(
      tx,
      userId,
      resolved.id,
      aliases,
      resolved.partitionKey,
      "partition",
    );
    return resolved.id;
  });
}

/** Resolve and update ordinary ingestion from the current profile under lock. */
export async function ensureUserSelfIdentityFromProfile(
  db: DrizzleDB,
  userId: string,
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
): Promise<{ nodeId: TypeId<"node">; aliases: string[] }> {
  return db.transaction(async (tx) => {
    await lockUserSelfIdentity(tx, userId);
    const aliases = await readStoredUserSelfAliases(tx, userId);
    const resolved = await resolveUserSelfPersonNode(
      tx,
      userId,
      partitionKey,
      accessScope,
    );
    await applyUserSelfIdentityToNode(
      tx,
      userId,
      resolved.id,
      aliases,
      resolved.partitionKey,
      "partition",
    );
    return { nodeId: resolved.id, aliases };
  });
}
