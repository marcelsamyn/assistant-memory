/** Fail-closed compatibility boundary for partitioned memory access. */
import {
  and,
  eq,
  inArray,
  isNull,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  memoryPartitions,
  partitionMigrationState,
  sourceIdentityTombstones,
  sourceTombstones,
  sources,
  nodes,
} from "~/db/schema";
import {
  MEMORY_PERSONAL_PARTITION_KEY,
  type ContextPartitionKey,
  type MemoryAccessScope,
} from "~/lib/schemas/partition";
import type { TypeId } from "~/types/typeid";

export type PartitionAccessErrorCode =
  | "PARTITION_REQUIRED"
  | "PARTITION_MIGRATION_REQUIRED"
  | "PARTITION_UNAUTHORIZED"
  | "SOURCE_VERSION_CONFLICT"
  | "SOURCE_IDENTITY_RETIRED"
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

/**
 * Returns the SQL predicate for one partition-aware table column.
 *
 * Strict callers keep the existing null-or-exact-key behavior. Workspace
 * callers see active partitions owned by this user in one bounded SQL query.
 * During an unmigrated or migrating user, legacy NULL rows remain visible so
 * the compatibility path does not lose data. Once migration is complete,
 * NULL rows are excluded.
 */
export function partitionAccessCondition(
  column: SQLWrapper,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope = "partition",
): SQL<unknown> {
  if (accessScope !== "workspace" || partitionKey !== undefined) {
    return partitionKey === undefined
      ? isNull(column)
      : eq(column, partitionKey);
  }

  return sql<boolean>`(
    (
      ${column} IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM ${memoryPartitions} AS workspace_partition
        WHERE workspace_partition.user_id = ${userId}
          AND workspace_partition.partition_key = ${column}
          AND workspace_partition.status = 'active'
      )
    )
    OR (
      ${column} IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM ${partitionMigrationState} AS workspace_migration
        WHERE workspace_migration.user_id = ${userId}
          AND workspace_migration.state = 'migrated'
      )
    )
  )`;
}

/** Adds a memory-owned personal destination for a migrated user. */
export async function ensurePersonalPartition(
  db: DrizzleDB,
  userId: string,
): Promise<ContextPartitionKey | undefined> {
  const [migration] = await db
    .select({ state: partitionMigrationState.state })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);
  if (!migration || migration.state !== "migrated") return undefined;

  await db
    .insert(memoryPartitions)
    .values({
      userId,
      partitionKey: MEMORY_PERSONAL_PARTITION_KEY,
      status: "active",
    })
    .onConflictDoNothing({
      target: [memoryPartitions.userId, memoryPartitions.partitionKey],
    });
  await assertPartitionReadAllowed(db, userId, MEMORY_PERSONAL_PARTITION_KEY);
  return MEMORY_PERSONAL_PARTITION_KEY;
}

export async function assertPartitionReadAllowed(
  db: DrizzleDB,
  userId: string,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope = "partition",
): Promise<void> {
  const [migration] = await db
    .select({ state: partitionMigrationState.state })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);

  if (partitionKey === undefined) {
    if (accessScope === "workspace") return;
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

/** Resolves an existing node's partition before a workspace mutation. */
export async function resolveNodePartition(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope = "partition",
): Promise<ContextPartitionKey | undefined> {
  if (accessScope !== "workspace" || partitionKey !== undefined) {
    return partitionKey;
  }
  const [node] = await db
    .select({ partitionKey: nodes.partitionKey })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, nodeId)))
    .limit(1);
  if (!node) return undefined;
  if (node.partitionKey === null) return undefined;
  await assertPartitionReadAllowed(db, userId, node.partitionKey);
  return node.partitionKey;
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

export interface SourceIdentity {
  userId: string;
  sourceType: typeof sources.$inferSelect.type;
  externalId: string;
}

function sourceIdentityKey(identity: SourceIdentity): string {
  return JSON.stringify([
    "source_identity",
    identity.userId,
    identity.sourceType,
    identity.externalId,
  ]);
}

/** Serialize source creation, revision writes, and caller-owned retirement. */
export async function lockSourceIdentityGates(
  db: Pick<DrizzleDB, "execute">,
  identities: readonly SourceIdentity[],
): Promise<void> {
  const keys = [...new Set(identities.map(sourceIdentityKey))].sort();
  for (const key of keys) {
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
}

/** Fail a write after its caller-owned identity has been retired. */
export async function assertSourceIdentitiesActive(
  db: Pick<DrizzleDB, "select">,
  identities: readonly SourceIdentity[],
): Promise<void> {
  if (identities.length === 0) return;
  const users = [...new Set(identities.map(({ userId }) => userId))];
  const types = [...new Set(identities.map(({ sourceType }) => sourceType))];
  const externalIds = [
    ...new Set(identities.map(({ externalId }) => externalId)),
  ];
  const retired = await db
    .select({
      userId: sourceIdentityTombstones.userId,
      sourceType: sourceIdentityTombstones.type,
      externalId: sourceIdentityTombstones.externalId,
    })
    .from(sourceIdentityTombstones)
    .where(
      and(
        inArray(sourceIdentityTombstones.userId, users),
        inArray(sourceIdentityTombstones.type, types),
        inArray(sourceIdentityTombstones.externalId, externalIds),
      ),
    );
  const activeKeys = new Set(identities.map(sourceIdentityKey));
  if (retired.some((identity) => activeKeys.has(sourceIdentityKey(identity)))) {
    throw new PartitionAccessError(
      "SOURCE_IDENTITY_RETIRED",
      "Source identity was retired before ingestion completed",
    );
  }
}

/** A parent edge must serialize with lifecycle tree discovery. */
export interface SourceParentAttachment {
  userId: string;
  sourceId: TypeId<"source">;
  partitionKey?: ContextPartitionKey;
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
        .select({ id: sources.id, partitionKey: sources.partitionKey })
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
    const expectedPartitionById = new Map<
      TypeId<"source">,
      ContextPartitionKey | null
    >();
    for (const parent of parents.filter(
      (candidate) => candidate.userId === userId,
    )) {
      expectedPartitionById.set(parent.sourceId, parent.partitionKey ?? null);
    }
    if (
      liveParents.length !== sourceIds.length ||
      tombstones.length > 0 ||
      liveParents.some(
        (parent) =>
          parent.partitionKey !== expectedPartitionById.get(parent.id),
      )
    ) {
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
    /** New identities not yet discoverable from the locked source rows. */
    sourceIdentities?: readonly SourceIdentity[];
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
  const discoveredIdentities =
    sourceIds.length === 0
      ? []
      : await db
          .select({
            userId: sources.userId,
            sourceType: sources.type,
            externalId: sources.externalId,
          })
          .from(sources)
          .where(
            and(
              eq(sources.userId, input.userId),
              inArray(sources.id, sourceIds),
            ),
          );
  const sourceIdentities = [
    ...discoveredIdentities,
    ...(input.sourceIdentities ?? []),
  ];
  if (sourceIds.length === 0)
    return db.transaction(async (tx) => {
      await lockSourceIdentityGates(tx, sourceIdentities);
      await assertSourceIdentitiesActive(tx, sourceIdentities);
      return write(tx, new Map());
    });

  return db.transaction(async (tx) => {
    await lockSourceIdentityGates(tx, sourceIdentities);
    await input.beforeSourceLocks?.(tx);
    // Stable ordering prevents two multi-source extractors from deadlocking.
    const lockedSources = await tx
      .select({
        id: sources.id,
        version: sources.version,
        deletedAt: sources.deletedAt,
        partitionKey: sources.partitionKey,
        sourceType: sources.type,
        externalId: sources.externalId,
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
    const discoveredKeys = new Set(discoveredIdentities.map(sourceIdentityKey));
    if (
      lockedSources.some(
        (source) =>
          !discoveredKeys.has(
            sourceIdentityKey({
              userId: input.userId,
              sourceType: source.sourceType,
              externalId: source.externalId,
            }),
          ),
      )
    ) {
      throw new PartitionAccessError(
        "SOURCE_VERSION_CONFLICT",
        "A source identity changed before its write fence was acquired",
      );
    }
    await assertSourceIdentitiesActive(tx, sourceIdentities);

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
