/** Alias operations for identity resolution and display names. */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { aliases, nodes } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

export type AliasSelect = typeof aliases.$inferSelect;

export interface CreateAliasInput {
  userId: string;
  canonicalNodeId: TypeId<"node">;
  aliasText: string;
}

/** Normalize alias text for exact matching. Common aliases: alias key, normalized alias. */
export function normalizeAliasText(aliasText: string): string {
  return aliasText.trim().toLowerCase();
}

async function assertCanonicalNodeOwnership(
  database: DrizzleDB,
  userId: string,
  canonicalNodeId: TypeId<"node">,
): Promise<void> {
  const [node] = await database
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, canonicalNodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!node) {
    throw new Error("Canonical node not found");
  }
}

/** Create an alias for a node, returning the existing row on duplicate input. */
export async function createAlias(
  database: DrizzleDB,
  input: CreateAliasInput,
): Promise<AliasSelect> {
  const normalizedAliasText = normalizeAliasText(input.aliasText);
  if (normalizedAliasText.length === 0) {
    throw new Error("Alias text is required");
  }

  await assertCanonicalNodeOwnership(
    database,
    input.userId,
    input.canonicalNodeId,
  );

  const [inserted] = await database
    .insert(aliases)
    .values({
      userId: input.userId,
      aliasText: input.aliasText,
      normalizedAliasText,
      canonicalNodeId: input.canonicalNodeId,
    })
    .onConflictDoNothing({
      target: [
        aliases.userId,
        aliases.normalizedAliasText,
        aliases.canonicalNodeId,
      ],
    })
    .returning();

  if (inserted) return inserted;

  const [existing] = await database
    .select()
    .from(aliases)
    .where(
      and(
        eq(aliases.userId, input.userId),
        eq(aliases.normalizedAliasText, normalizedAliasText),
        eq(aliases.canonicalNodeId, input.canonicalNodeId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error("Failed to create alias");
  }

  return existing;
}

/** Delete an alias scoped to the owning user. */
export async function deleteAlias(
  database: DrizzleDB,
  userId: string,
  aliasId: TypeId<"alias">,
): Promise<boolean> {
  const deleted = await database
    .delete(aliases)
    .where(and(eq(aliases.id, aliasId), eq(aliases.userId, userId)))
    .returning({ id: aliases.id });

  return deleted.length > 0;
}

/** Delete an alias matched by `(userId, normalizedAliasText, canonicalNodeId)`. */
export async function deleteAliasByText(
  database: DrizzleDB,
  userId: string,
  canonicalNodeId: TypeId<"node">,
  aliasText: string,
): Promise<boolean> {
  const normalizedAliasText = normalizeAliasText(aliasText);
  if (normalizedAliasText.length === 0) return false;

  const deleted = await database
    .delete(aliases)
    .where(
      and(
        eq(aliases.userId, userId),
        eq(aliases.canonicalNodeId, canonicalNodeId),
        eq(aliases.normalizedAliasText, normalizedAliasText),
      ),
    )
    .returning({ id: aliases.id });

  return deleted.length > 0;
}

/** Fetch aliases for a set of nodes, grouped by canonical node id. */
export async function listAliasesForNodeIds(
  database: DrizzleDB,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<Map<TypeId<"node">, AliasSelect[]>> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  const aliasMap = new Map<TypeId<"node">, AliasSelect[]>();
  for (const nodeId of uniqueNodeIds) {
    aliasMap.set(nodeId, []);
  }

  if (uniqueNodeIds.length === 0) {
    return aliasMap;
  }

  const rows = await database
    .select()
    .from(aliases)
    .where(
      and(
        eq(aliases.userId, userId),
        inArray(aliases.canonicalNodeId, uniqueNodeIds),
      ),
    )
    .orderBy(asc(aliases.createdAt), asc(aliases.aliasText));

  for (const alias of rows) {
    aliasMap.get(alias.canonicalNodeId)?.push(alias);
  }

  return aliasMap;
}
