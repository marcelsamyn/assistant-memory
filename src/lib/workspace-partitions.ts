import { and, asc, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { memoryPartitions, partitionMigrationState } from "~/db/schema";
import { PartitionAccessError } from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";

/**
 * Resolve a workspace request into strict operation scopes. Aggregate
 * authority never crosses a route/job boundary: callers receive one active
 * partition per strict invocation. Legacy users retain the unpartitioned
 * scope until migration is complete.
 */
export async function resolveWorkspacePartitions(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope,
): Promise<Array<ContextPartitionKey | undefined>> {
  if (partitionKey !== undefined || accessScope !== "workspace") {
    return [partitionKey];
  }

  const [migration] = await db
    .select({ state: partitionMigrationState.state })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);
  const active = await db
    .select({ partitionKey: memoryPartitions.partitionKey })
    .from(memoryPartitions)
    .where(
      and(
        eq(memoryPartitions.userId, userId),
        eq(memoryPartitions.status, "active"),
      ),
    )
    .orderBy(asc(memoryPartitions.partitionKey));
  if (migration?.state === "migrated") {
    return active.map((row) => row.partitionKey);
  }
  if (active.length > 0) {
    // Before migration completes, retain the legacy NULL scope as a separate
    // strict operation instead of silently dropping it.
    return [...active.map((row) => row.partitionKey), undefined];
  }
  return [undefined];
}

/**
 * Fail closed before an aggregate write or job can reach a strict worker.
 * Legacy NULL rows remain readable while migration is in progress, but strict
 * writes cannot safely address that mixed scope.
 */
export async function assertWorkspaceOperationReady(
  db: DrizzleDB,
  userId: string,
  partitions: readonly (ContextPartitionKey | undefined)[],
  accessScope: MemoryAccessScope,
): Promise<void> {
  if (accessScope !== "workspace" || !partitions.includes(undefined)) return;

  const [migration] = await db
    .select({ state: partitionMigrationState.state })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);
  if (migration) {
    throw new PartitionAccessError(
      "PARTITION_REQUIRED",
      `Workspace operation is unavailable while memory partition migration is ${migration.state}`,
    );
  }
}
