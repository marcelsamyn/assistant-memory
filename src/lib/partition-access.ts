/** Fail-closed compatibility boundary for partitioned memory access. */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  memoryPartitions,
  partitionMigrationState,
  sourceTombstones,
  sources,
} from "~/db/schema";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { TypeId } from "~/types/typeid";

export type PartitionAccessErrorCode =
  | "PARTITION_REQUIRED"
  | "PARTITION_MIGRATION_REQUIRED"
  | "PARTITION_UNAUTHORIZED"
  | "SOURCE_VERSION_CONFLICT"
  | "SOURCE_TOMBSTONED";

export class PartitionAccessError extends Error {
  constructor(
    readonly code: PartitionAccessErrorCode,
    message: string,
    readonly currentSourceVersion?: number,
  ) {
    super(message);
    this.name = "PartitionAccessError";
  }
}

export async function assertPartitionReadAllowed(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
): Promise<void> {
  const [migration] = await db
    .select({ state: partitionMigrationState.state })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);

  if (partitionKey === undefined) {
    if (migration) {
      throw new PartitionAccessError(
        "PARTITION_REQUIRED",
        `Memory partition is required for user ${userId} after partition migration starts`,
      );
    }
    return;
  }

  if (!migration) {
    throw new PartitionAccessError(
      "PARTITION_MIGRATION_REQUIRED",
      `Partition migration must start before partitioned access for user ${userId}`,
    );
  }

  const [partition] = await db
    .select({ status: memoryPartitions.status })
    .from(memoryPartitions)
    .where(
      and(
        eq(memoryPartitions.userId, userId),
        eq(memoryPartitions.partitionKey, partitionKey),
      ),
    )
    .limit(1);
  if (!partition || partition.status !== "active") {
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      `Memory partition is not registered and active for user ${userId}`,
    );
  }
}

export async function preparePartitionWrite(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
): Promise<void> {
  const [migration] = await db
    .select({ state: partitionMigrationState.state })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);

  if (partitionKey === undefined) {
    if (migration) {
      throw new PartitionAccessError(
        "PARTITION_REQUIRED",
        `Unpartitioned memory writes are fenced for user ${userId}`,
      );
    }
    return;
  }

  if (!migration) {
    throw new PartitionAccessError(
      "PARTITION_MIGRATION_REQUIRED",
      `Partition migration must start before partitioned writes for user ${userId}`,
    );
  }

  await db
    .insert(memoryPartitions)
    .values({ userId, partitionKey, status: "active" })
    .onConflictDoNothing({
      target: [memoryPartitions.userId, memoryPartitions.partitionKey],
    });
  await assertPartitionReadAllowed(db, userId, partitionKey);
}

export interface AssertSourcePartitionInput {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  partitionKey: ContextPartitionKey | undefined;
  /** Enqueue-time source version; detects mutate-away-and-back ABA races. */
  expectedSourceVersion?: number;
}

/** Fences delayed workers whose source or protected input changed after enqueue. */
export async function assertSourcePartition({
  db,
  userId,
  sourceId,
  partitionKey,
  expectedSourceVersion,
}: AssertSourcePartitionInput): Promise<void> {
  await assertPartitionReadAllowed(db, userId, partitionKey);
  const [source] = await db
    .select({ partitionKey: sources.partitionKey, version: sources.version })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)))
    .limit(1);
  if (!source)
    throw new Error(`Source ${sourceId} was not found for user ${userId}`);
  if (source.partitionKey !== (partitionKey ?? null)) {
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      `Source ${sourceId} no longer belongs to the requested memory partition`,
    );
  }
  if (
    expectedSourceVersion !== undefined &&
    source.version !== expectedSourceVersion
  ) {
    throw new PartitionAccessError(
      "SOURCE_VERSION_CONFLICT",
      `Source ${sourceId} changed after this work was scheduled: expected version ${expectedSourceVersion}, found ${source.version}`,
      source.version,
    );
  }
}

type Transaction = Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];
type SourceParentGateDatabase = Pick<DrizzleDB, "execute" | "select">;

/** A parent edge must serialize with lifecycle tree discovery. */
export interface SourceParentAttachment {
  userId: string;
  sourceId: TypeId<"source">;
}

/**
 * Takes transaction-scoped parent gates in a total order.
 *
 * Child attachment and lifecycle tree discovery use this same gate before
 * their row locks. A lifecycle command can therefore close a complete tree
 * without a child appearing in the interval between recursive discovery and
 * row locking.
 */
export async function lockSourceParentAttachmentGates(
  tx: SourceParentGateDatabase,
  parents: readonly SourceParentAttachment[],
): Promise<void> {
  const uniqueParents = [
    ...new Map(
      parents.map((parent) => [`${parent.userId}:${parent.sourceId}`, parent]),
    ).values(),
  ].sort((left, right) =>
    `${left.userId}:${left.sourceId}`.localeCompare(
      `${right.userId}:${right.sourceId}`,
    ),
  );
  for (const parent of uniqueParents) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`source-parent:${parent.userId}:${parent.sourceId}`}))`,
    );
  }
}

/** Validates every parent while its shared attachment gate is held. */
export async function assertLiveSourceParents(
  tx: SourceParentGateDatabase,
  parents: readonly SourceParentAttachment[],
): Promise<void> {
  const parentsByUser = new Map<string, TypeId<"source">[]>();
  for (const parent of parents) {
    const ids = parentsByUser.get(parent.userId) ?? [];
    if (!ids.includes(parent.sourceId)) ids.push(parent.sourceId);
    parentsByUser.set(parent.userId, ids);
  }
  for (const [userId, sourceIds] of parentsByUser) {
    const [liveParents, tombstones] = await Promise.all([
      tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.userId, userId),
            inArray(sources.id, sourceIds),
            isNull(sources.deletedAt),
          ),
        )
        .orderBy(sources.id)
        .for("update"),
      tx
        .select({ sourceId: sourceTombstones.sourceId })
        .from(sourceTombstones)
        .where(
          and(
            eq(sourceTombstones.userId, userId),
            inArray(sourceTombstones.sourceId, sourceIds),
          ),
        ),
    ]);
    if (liveParents.length !== sourceIds.length || tombstones.length > 0) {
      throw new PartitionAccessError(
        "SOURCE_TOMBSTONED",
        "A child source cannot attach to a removed or tombstoned parent",
      );
    }
  }
}

export interface SourceWriteFence {
  sourceId: TypeId<"source">;
  /** The source version observed before work left the database. */
  expectedSourceVersion?: number;
}

/**
 * Serializes source-derived writes with source lifecycle erasure.
 *
 * A worker can spend minutes reading or calling an LLM after its initial
 * authority check. This helper takes the same source-row lock as tombstone,
 * verifies that every cited source is still live at its observed version, and
 * executes only the short durable write section while that lock is held. A
 * tombstone therefore either erases the completed write after it commits or
 * commits first and makes this callback fail closed; no late worker can
 * recreate source-linked evidence.
 */
export async function withSourceWriteFence<T>(
  db: DrizzleDB,
  input: {
    userId: string;
    sources: readonly SourceWriteFence[];
    /** When present, every locked source must still belong to this partition. */
    partitionKey?: ContextPartitionKey | undefined;
    /**
     * Acquires cross-boundary transaction gates before source-row locks.
     *
     * Child attachment uses this for the parent advisory gate. Lifecycle
     * discovery takes the same gate before it locks a source row, so this
     * ordering is part of the deletion/ingestion deadlock contract.
     */
    beforeSourceLocks?: (tx: Transaction) => Promise<void>;
  },
  write: (
    tx: Transaction,
    sourceVersions: ReadonlyMap<TypeId<"source">, number>,
  ) => Promise<T>,
): Promise<T> {
  const expectedBySource = new Map<TypeId<"source">, number | undefined>();
  for (const source of input.sources) {
    const existing = expectedBySource.get(source.sourceId);
    if (
      existing !== undefined &&
      source.expectedSourceVersion !== undefined &&
      existing !== source.expectedSourceVersion
    ) {
      throw new PartitionAccessError(
        "SOURCE_VERSION_CONFLICT",
        `Conflicting source versions supplied for ${source.sourceId}`,
      );
    }
    if (!expectedBySource.has(source.sourceId)) {
      expectedBySource.set(source.sourceId, source.expectedSourceVersion);
    }
  }
  const sourceIds = [...expectedBySource.keys()].sort();
  if (sourceIds.length === 0)
    return db.transaction((tx) => write(tx, new Map()));

  return db.transaction(async (tx) => {
    await input.beforeSourceLocks?.(tx);
    // Stable ordering prevents two multi-source extractors from deadlocking.
    const lockedSources = await tx
      .select({
        id: sources.id,
        version: sources.version,
        deletedAt: sources.deletedAt,
        partitionKey: sources.partitionKey,
      })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), inArray(sources.id, sourceIds)),
      )
      .orderBy(sources.id)
      .for("update");
    if (lockedSources.length !== sourceIds.length) {
      throw new PartitionAccessError(
        "SOURCE_TOMBSTONED",
        "A source was removed before its derived write could be committed",
      );
    }

    const tombstones = await tx
      .select({ sourceId: sourceTombstones.sourceId })
      .from(sourceTombstones)
      .where(
        and(
          eq(sourceTombstones.userId, input.userId),
          inArray(sourceTombstones.sourceId, sourceIds),
        ),
      );
    if (
      tombstones.length > 0 ||
      lockedSources.some((source) => source.deletedAt)
    ) {
      throw new PartitionAccessError(
        "SOURCE_TOMBSTONED",
        "A source was tombstoned before its derived write could be committed",
      );
    }
    if (
      "partitionKey" in input &&
      lockedSources.some(
        (source) => source.partitionKey !== (input.partitionKey ?? null),
      )
    ) {
      throw new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "A source no longer belongs to the requested memory partition",
      );
    }

    const versions = new Map(
      lockedSources.map((source) => [source.id, source.version]),
    );
    for (const [sourceId, expectedVersion] of expectedBySource) {
      const currentVersion = versions.get(sourceId);
      if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
        throw new PartitionAccessError(
          "SOURCE_VERSION_CONFLICT",
          `Source ${sourceId} changed before its derived write could be committed: expected ${expectedVersion}, found ${currentVersion}`,
          currentVersion,
        );
      }
    }
    return write(tx, versions);
  });
}
