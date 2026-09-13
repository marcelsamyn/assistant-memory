/** Alias operations for identity resolution and display names. */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { aliases, nodes } from "~/db/schema";
import {
  assertPartitionReadAllowed,
  partitionAccessCondition,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
import type { TypeId } from "~/types/typeid";

export type AliasSelect = typeof aliases.$inferSelect;

export interface CreateAliasInput {
  userId: string;
  partitionKey?: ContextPartitionKey | undefined;
  canonicalNodeId: TypeId<"node">;
  aliasText: string;
  accessScope?: MemoryAccessScope;
}

/** Normalize alias text for exact matching. Common aliases: alias key, normalized alias. */
export function normalizeAliasText(aliasText: string): string {
  return aliasText.trim().toLowerCase();
}

async function assertCanonicalNodeOwnership(
  database: DrizzleDB,
  userId: string,
  canonicalNodeId: TypeId<"node">,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope,
): Promise<ContextPartitionKey | null> {
  const [node] = await database
    .select({ id: nodes.id, partitionKey: nodes.partitionKey })
    .from(nodes)
    .where(
      and(
        eq(nodes.id, canonicalNodeId),
        eq(nodes.userId, userId),
        partitionAccessCondition(
          nodes.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
      ),
    )
    .limit(1);

  if (!node) {
    throw new Error("Canonical node not found");
  }
  return node.partitionKey;
}

/** Create an alias for a node, returning the existing row on duplicate input. */
export async function createAlias(
  database: DrizzleDB,
  input: CreateAliasInput,
): Promise<AliasSelect> {
  const accessScope = input.accessScope ?? "partition";
  await assertPartitionReadAllowed(
    database,
    input.userId,
    input.partitionKey,
    accessScope,
  );
  const normalizedAliasText = normalizeAliasText(input.aliasText);
  if (normalizedAliasText.length === 0) {
    throw new Error("Alias text is required");
  }

  const partitionKey = await assertCanonicalNodeOwnership(
    database,
    input.userId,
    input.canonicalNodeId,
    input.partitionKey,
    accessScope,
  );
  await preparePartitionWrite(
    database,
    input.userId,
    partitionKey ?? undefined,
  );

  const [inserted] = await database
    .insert(aliases)
    .values({
      userId: input.userId,
      aliasText: input.aliasText,
      normalizedAliasText,
      canonicalNodeId: input.canonicalNodeId,
      partitionKey,
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
        partitionAccessCondition(
          aliases.partitionKey,
          input.userId,
          partitionKey ?? undefined,
        ),
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
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
): Promise<boolean> {
  await assertPartitionReadAllowed(database, userId, partitionKey, accessScope);
  const [existing] = await database
    .select({ partitionKey: aliases.partitionKey })
    .from(aliases)
    .where(
      and(
        eq(aliases.id, aliasId),
        eq(aliases.userId, userId),
        partitionAccessCondition(
          aliases.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
      ),
    )
    .limit(1);
  if (!existing) return false;
  const objectPartitionKey = existing.partitionKey ?? undefined;
  await preparePartitionWrite(database, userId, objectPartitionKey);
  const deleted = await database
    .delete(aliases)
    .where(
      and(
        eq(aliases.id, aliasId),
        eq(aliases.userId, userId),
        partitionAccessCondition(
          aliases.partitionKey,
          userId,
          objectPartitionKey,
        ),
      ),
    )
    .returning({ id: aliases.id });

  return deleted.length > 0;
}

/** Delete an alias matched by `(userId, normalizedAliasText, canonicalNodeId)`. */
export async function deleteAliasByText(
  database: DrizzleDB,
  userId: string,
  canonicalNodeId: TypeId<"node">,
  aliasText: string,
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
): Promise<boolean> {
  await assertPartitionReadAllowed(database, userId, partitionKey, accessScope);
  const normalizedAliasText = normalizeAliasText(aliasText);
  if (normalizedAliasText.length === 0) return false;

  const [existing] = await database
    .select({ partitionKey: aliases.partitionKey })
    .from(aliases)
    .where(
      and(
        eq(aliases.userId, userId),
        partitionAccessCondition(
          aliases.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
        eq(aliases.canonicalNodeId, canonicalNodeId),
        eq(aliases.normalizedAliasText, normalizedAliasText),
      ),
    )
    .limit(1);
  if (!existing) return false;
  const objectPartitionKey = existing.partitionKey ?? undefined;
  await preparePartitionWrite(database, userId, objectPartitionKey);
  const deleted = await database
    .delete(aliases)
    .where(
      and(
        eq(aliases.userId, userId),
        partitionAccessCondition(
          aliases.partitionKey,
          userId,
          objectPartitionKey,
        ),
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
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
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
        partitionAccessCondition(
          aliases.partitionKey,
          userId,
          partitionKey,
          accessScope,
        ),
        inArray(aliases.canonicalNodeId, uniqueNodeIds),
      ),
    )
    .orderBy(asc(aliases.createdAt), asc(aliases.aliasText));

  for (const alias of rows) {
    aliasMap.get(alias.canonicalNodeId)?.push(alias);
  }

  return aliasMap;
}
