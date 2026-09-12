/** Atomic source reclassification with durable identity-split recovery. */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  memoryPartitions,
  nodes,
  nodeRedirects,
  partitionMigrationState,
  sourceLinks,
  sourceIngestionOperations,
  sourceIdentityTombstones,
  sourcePartitionCommands,
  sourceTombstones,
  sources,
} from "~/db/schema";
import { reclassifyContextualSourceExternalId } from "~/lib/ingestion/source-identity";
import {
  lockSourceParentAttachmentGates,
  lockSourceIdentityGates,
} from "~/lib/partition-access";
import {
  recoverPartitionNode,
  reusePartitionNodeMapping,
} from "~/lib/partition-artifact-recovery";
import { PartitionReclassificationError } from "~/lib/partition-errors";
import { setPartitionMigrationState } from "~/lib/partition-migration";
import {
  partitionNodeMappingSchema,
  type PartitionNodeMapping,
  type ReclassifySourcePartitionRequest,
  type ReclassifySourcePartitionResponse,
} from "~/lib/schemas/partition";
import { typeIdFromString, typeIdSchema, type TypeId } from "~/types/typeid";

export { PartitionReclassificationError, setPartitionMigrationState };

type Transaction = Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];

interface LockedSource {
  id: TypeId<"source">;
  userId: string;
  partitionKey: ReclassifySourcePartitionRequest["expectedPartitionKey"];
  version: number;
  deletedAt: Date | null;
  type: typeof sources.$inferSelect.type;
  externalId: string;
  metadata: unknown;
}

export async function reclassifySourcePartition(
  db: DrizzleDB,
  request: ReclassifySourcePartitionRequest,
): Promise<ReclassifySourcePartitionResponse> {
  return db.transaction(async (tx) => {
    const [migration] = await tx
      .select({
        state: partitionMigrationState.state,
        version: partitionMigrationState.version,
      })
      .from(partitionMigrationState)
      .where(eq(partitionMigrationState.userId, request.userId))
      .limit(1);
    if (!migration) {
      throw new PartitionReclassificationError(
        "MIGRATION_STATE_CONFLICT",
        "Partition migration must be started before reclassifying sources",
        { migrationState: "unmigrated", migrationVersion: 0 },
      );
    }

    const sourceTree = await loadAndLockSourceTree(tx, request);
    const source = sourceTree.find((row) => row.id === request.sourceId);
    if (!source || sourceTree.length === 0) {
      throw new PartitionReclassificationError(
        "SOURCE_NOT_FOUND",
        `Source ${request.sourceId} was not found for user ${request.userId}`,
        {
          migrationState: migration.state,
          migrationVersion: migration.version,
        },
      );
    }
    const [tombstone] = await tx
      .select({ sourceId: sourceTombstones.sourceId })
      .from(sourceTombstones)
      .where(
        and(
          eq(sourceTombstones.userId, request.userId),
          eq(sourceTombstones.sourceId, request.sourceId),
        ),
      )
      .limit(1);
    if (tombstone || sourceTree.some((treeSource) => treeSource.deletedAt)) {
      throw new PartitionReclassificationError(
        "SOURCE_NOT_FOUND",
        "A tombstoned source cannot resume or replay partition recovery",
        {
          migrationState: migration.state,
          migrationVersion: migration.version,
          sourcePartitionKey: source.partitionKey,
          sourceVersion: source.version,
        },
      );
    }
    const concurrentReplay = await loadCommand(
      tx,
      request.userId,
      request.bindingGeneration,
    );
    if (concurrentReplay) {
      return replayCommand(
        request,
        concurrentReplay,
        sourceTree.map((row) => row.id),
      );
    }
    const sourceIds = sourceTree.map((row) => row.id);
    if (sourceTree.some((row) => row.userId !== request.userId)) {
      throw new PartitionReclassificationError(
        "SOURCE_PARTITION_CONFLICT",
        "A parent or child source belongs to a different user",
        {
          migrationState: migration.state,
          migrationVersion: migration.version,
          sourcePartitionKey: source.partitionKey,
          sourceVersion: source.version,
        },
      );
    }
    const sourcePartitionsMatch = sourceTree.every(
      (row) => row.partitionKey === request.expectedPartitionKey,
    );
    if (!sourcePartitionsMatch) {
      throw new PartitionReclassificationError(
        "SOURCE_PARTITION_CONFLICT",
        "Every parent and child source must be in the expected source partition before an atomic move",
        {
          migrationState: migration.state,
          migrationVersion: migration.version,
          sourcePartitionKey: source.partitionKey,
          sourceVersion: source.version,
        },
      );
    }
    const authoritativeState = {
      migrationState: migration.state,
      migrationVersion: migration.version,
      sourcePartitionKey: source.partitionKey,
      sourceVersion: source.version,
    };
    if (source.version !== request.expectedSourceVersion) {
      throw new PartitionReclassificationError(
        "SOURCE_VERSION_CONFLICT",
        `Source version changed: expected ${request.expectedSourceVersion}, found ${source.version}`,
        authoritativeState,
      );
    }
    if (source.partitionKey !== request.expectedPartitionKey) {
      throw new PartitionReclassificationError(
        "SOURCE_PARTITION_CONFLICT",
        "Source partition changed before this migration command was applied",
        authoritativeState,
      );
    }

    await ensureActiveTargetPartition(tx, request);
    const touchedNodeIds = await loadTouchedNodeIds(tx, request, sourceIds);
    // Move the source tree before rewiring evidence. Source-link triggers use
    // the authoritative source partition to route provenance events; doing
    // this after rewiring would route those events to the old/global feed.
    // Integrity triggers are deferred, so the whole dependent update remains
    // atomic while node and claim rows catch up below.
    const updatedSources = await updateSourceTreePartitions(
      tx,
      request,
      sourceTree,
    );
    const updatedSource = updatedSources.find(
      (row) => row.id === request.sourceId,
    );
    if (!updatedSource)
      throw new Error("Primary source disappeared during atomic move");

    const nodeMappings = await moveOrSplitNodes(
      tx,
      request,
      sourceIds,
      touchedNodeIds,
    );
    const movedClaims = await rewireSourceEvidence(
      tx,
      request,
      sourceIds,
      nodeMappings,
    );

    await tx.insert(sourcePartitionCommands).values({
      userId: request.userId,
      bindingGeneration: request.bindingGeneration,
      sourceId: request.sourceId,
      expectedPartitionKey: request.expectedPartitionKey,
      targetPartitionKey: request.targetPartitionKey,
      expectedSourceVersion: request.expectedSourceVersion,
      sourceVersion: updatedSource.version,
      movedClaimCount: movedClaims.length,
      sourceIds,
      nodeMappings,
    });
    return {
      sourceId: request.sourceId,
      partitionKey: request.targetPartitionKey,
      sourceVersion: updatedSource.version,
      bindingGeneration: request.bindingGeneration,
      replayed: false,
      movedClaimCount: movedClaims.length,
      nodeMappings,
    };
  });
}

async function ensureActiveTargetPartition(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
): Promise<void> {
  await tx
    .insert(memoryPartitions)
    .values({
      userId: request.userId,
      partitionKey: request.targetPartitionKey,
      status: "active",
    })
    .onConflictDoNothing({
      target: [memoryPartitions.userId, memoryPartitions.partitionKey],
    });
  const [partition] = await tx
    .select({ status: memoryPartitions.status })
    .from(memoryPartitions)
    .where(
      and(
        eq(memoryPartitions.userId, request.userId),
        eq(memoryPartitions.partitionKey, request.targetPartitionKey),
      ),
    )
    .limit(1);
  if (partition?.status !== "active") {
    throw new PartitionReclassificationError(
      "SOURCE_PARTITION_CONFLICT",
      "Target partition is quarantined",
      { targetPartitionKey: request.targetPartitionKey },
    );
  }
}

async function loadSourceTreeIds(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
): Promise<TypeId<"source">[] | null> {
  const result = await tx.execute<{ source_id: string }>(sql`
    WITH RECURSIVE ancestors(source_id, parent_source) AS (
      SELECT id, parent_source
      FROM ${sources}
      WHERE user_id = ${request.userId} AND id = ${request.sourceId}
      UNION
      SELECT parent.id, parent.parent_source
      FROM ${sources} parent
      JOIN ancestors child ON child.parent_source = parent.id
      WHERE parent.user_id = ${request.userId}
    ), descendants(source_id) AS (
      SELECT source_id
      FROM ancestors
      WHERE parent_source IS NULL
      UNION
      SELECT child.id
      FROM ${sources} child
      JOIN descendants parent ON child.parent_source = parent.source_id
    ), source_tree(source_id) AS (
      SELECT source_id FROM ancestors
      UNION
      SELECT source_id FROM descendants
    )
    SELECT source_id FROM source_tree ORDER BY source_id
  `);
  if (result.rows.length === 0) return null;
  return result.rows.map((row) => typeIdFromString("source", row.source_id));
}

async function loadAndLockSourceTree(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
): Promise<LockedSource[]> {
  const sourceIds = await loadSourceTreeIds(tx, request);
  if (!sourceIds) return [];
  const discovered = await tx
    .select()
    .from(sources)
    .where(inArray(sources.id, sourceIds));
  // Identity gates precede containment and row locks, as they do in ingestion.
  // Lock both names so neither an ingest nor retirement can claim the new one.
  await lockSourceIdentityGates(
    tx,
    discovered.flatMap((source) =>
      [
        source.externalId,
        reclassifyContextualSourceExternalId({
          ...source,
          expectedPartitionKey: source.partitionKey,
          targetPartitionKey: request.targetPartitionKey,
        }),
      ].map((externalId) => ({
        userId: source.userId,
        sourceType: source.type,
        externalId,
      })),
    ),
  );
  await lockSourceParentAttachmentGates(
    tx,
    sourceIds.map((sourceId) => ({ userId: request.userId, sourceId })),
  );
  const rediscovered = await loadSourceTreeIds(tx, request);
  if (
    !rediscovered ||
    rediscovered.length !== sourceIds.length ||
    rediscovered.some((id, index) => id !== sourceIds[index])
  ) {
    throw new PartitionReclassificationError(
      "SOURCE_VERSION_CONFLICT",
      "Source tree changed while acquiring identity and containment gates; retry the move",
    );
  }
  const rows: LockedSource[] = [];
  for (const sourceId of [...sourceIds].sort()) {
    const [row] = await tx
      .select({
        id: sources.id,
        userId: sources.userId,
        partitionKey: sources.partitionKey,
        version: sources.version,
        deletedAt: sources.deletedAt,
        type: sources.type,
        externalId: sources.externalId,
        metadata: sources.metadata,
      })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .for("update")
      .limit(1);
    if (!row) {
      throw new PartitionReclassificationError(
        "SOURCE_NOT_FOUND",
        `A parent or child source disappeared while locking the source tree`,
      );
    }
    const observed = discovered.find((source) => source.id === row.id);
    const gatedExternalIds = observed
      ? [
          observed.externalId,
          reclassifyContextualSourceExternalId({
            ...observed,
            expectedPartitionKey: observed.partitionKey,
            targetPartitionKey: request.targetPartitionKey,
          }),
        ]
      : [];
    if (
      !observed ||
      observed.userId !== row.userId ||
      observed.type !== row.type ||
      !gatedExternalIds.includes(row.externalId) ||
      !gatedExternalIds.includes(
        reclassifyContextualSourceExternalId({
          ...row,
          expectedPartitionKey: row.partitionKey,
          targetPartitionKey: request.targetPartitionKey,
        }),
      )
    ) {
      throw new PartitionReclassificationError(
        "SOURCE_VERSION_CONFLICT",
        "Source identity changed while acquiring its gates; retry the move",
      );
    }
    rows.push(row);
  }
  return rows;
}

async function updateSourceTreePartitions(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
  sourceTree: LockedSource[],
): Promise<Array<{ id: TypeId<"source">; version: number }>> {
  const updated: Array<{ id: TypeId<"source">; version: number }> = [];
  for (const source of sourceTree) {
    const externalId = reclassifyContextualSourceExternalId({
      ...source,
      expectedPartitionKey: source.partitionKey,
      targetPartitionKey: request.targetPartitionKey,
    });
    if (externalId !== source.externalId) {
      const [existingSource] = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.userId, source.userId),
            eq(sources.type, source.type),
            eq(sources.externalId, externalId),
          ),
        )
        .limit(1);
      const [existingRetirement] = await tx
        .select({ externalId: sourceIdentityTombstones.externalId })
        .from(sourceIdentityTombstones)
        .where(
          and(
            eq(sourceIdentityTombstones.userId, source.userId),
            eq(sourceIdentityTombstones.type, source.type),
            eq(sourceIdentityTombstones.externalId, externalId),
          ),
        )
        .limit(1);
      if (existingSource || existingRetirement)
        throw new PartitionReclassificationError(
          "SOURCE_PARTITION_CONFLICT",
          "The destination source identity is already present or retired",
        );
    }
    const [row] = await tx
      .update(sources)
      .set({
        partitionKey: request.targetPartitionKey,
        externalId,
        metadata: sql`CASE WHEN ${sources.metadata}->'sourceContext' ? 'parentPartitionKey' THEN jsonb_set(${sources.metadata}, '{sourceContext,parentPartitionKey}', to_jsonb(${request.targetPartitionKey}::text)) ELSE ${sources.metadata} END`,
      })
      .where(
        and(
          eq(sources.userId, request.userId),
          eq(sources.id, source.id),
          eq(sources.version, source.version),
          source.partitionKey === null
            ? isNull(sources.partitionKey)
            : eq(sources.partitionKey, source.partitionKey),
        ),
      )
      .returning({ id: sources.id, version: sources.version });
    if (!row) {
      throw new PartitionReclassificationError(
        "SOURCE_VERSION_CONFLICT",
        "A parent or child source changed concurrently while applying the atomic partition migration",
        {
          sourcePartitionKey: source.partitionKey,
          sourceVersion: source.version,
        },
      );
    }
    await tx
      .update(sourceIngestionOperations)
      .set({
        partitionKey: request.targetPartitionKey,
        externalId,
        sourceVersion: sql`CASE WHEN ${sourceIngestionOperations.status} IN ('queued', 'processing') AND ${sourceIngestionOperations.sourceVersion} = ${source.version} THEN ${row.version} ELSE ${sourceIngestionOperations.sourceVersion} END`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceIngestionOperations.userId, request.userId),
          eq(sourceIngestionOperations.sourceId, source.id),
        ),
      );
    const retirementIdentity = and(
      eq(sourceIdentityTombstones.userId, source.userId),
      eq(sourceIdentityTombstones.type, source.type),
      eq(sourceIdentityTombstones.externalId, source.externalId),
    );
    if (externalId !== source.externalId) {
      const [retirement] = await tx
        .select()
        .from(sourceIdentityTombstones)
        .where(retirementIdentity)
        .limit(1);
      if (retirement) {
        // Late requests still use the old canonical identity. Keep its gate
        // closed even if the destination identity is explicitly restored.
        await tx.insert(sourceIdentityTombstones).values({
          ...retirement,
          externalId,
          partitionKey: request.targetPartitionKey,
        });
      }
    } else {
      await tx
        .update(sourceIdentityTombstones)
        .set({ partitionKey: request.targetPartitionKey })
        .where(retirementIdentity);
    }
    updated.push(row);
  }
  return updated;
}

async function loadTouchedNodeIds(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
  sourceIds: TypeId<"source">[],
): Promise<TypeId<"node">[]> {
  const [links, sourceClaims] = await Promise.all([
    tx
      .select({ nodeId: sourceLinks.nodeId })
      .from(sourceLinks)
      .where(inArray(sourceLinks.sourceId, sourceIds)),
    tx
      .select({
        subjectNodeId: claims.subjectNodeId,
        objectNodeId: claims.objectNodeId,
        assertedByNodeId: claims.assertedByNodeId,
      })
      .from(claims)
      .where(
        and(
          eq(claims.userId, request.userId),
          inArray(claims.sourceId, sourceIds),
        ),
      ),
  ]);
  return [
    ...new Set<TypeId<"node">>([
      ...links.map((row) => row.nodeId),
      ...sourceClaims.flatMap((claim) =>
        [
          claim.subjectNodeId,
          claim.objectNodeId,
          claim.assertedByNodeId,
        ].filter((nodeId): nodeId is TypeId<"node"> => nodeId !== null),
      ),
    ]),
  ];
}

async function moveOrSplitNodes(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
  sourceIds: TypeId<"source">[],
  nodeIds: TypeId<"node">[],
): Promise<PartitionNodeMapping[]> {
  const mappings: PartitionNodeMapping[] = [];
  for (const sourceNodeId of nodeIds) {
    const [node] = await tx
      .select({ nodeType: nodes.nodeType })
      .from(nodes)
      .where(and(eq(nodes.userId, request.userId), eq(nodes.id, sourceNodeId)))
      .limit(1);
    if (!node) continue;
    const recoveryInput = {
      tx,
      userId: request.userId,
      sourceId: request.sourceId,
      sourceNodeId,
      nodeType: node.nodeType,
      partitionKey: request.targetPartitionKey,
      bindingGeneration: request.bindingGeneration,
    };
    const reused = await reusePartitionNodeMapping(recoveryInput);
    if (reused) {
      mappings.push(reused);
      continue;
    }
    if (
      await nodeHasOtherPartitionSupport(tx, request, sourceIds, sourceNodeId)
    ) {
      mappings.push(await recoverPartitionNode(recoveryInput));
      continue;
    }
    await moveNodePartitionDependencies(tx, request, sourceNodeId);
    await tx
      .update(nodes)
      .set({ partitionKey: request.targetPartitionKey })
      .where(eq(nodes.id, sourceNodeId));
  }
  return mappings;
}

async function moveNodePartitionDependencies(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
  nodeId: TypeId<"node">,
): Promise<void> {
  await Promise.all([
    tx
      .update(aliases)
      .set({ partitionKey: request.targetPartitionKey })
      .where(
        and(
          eq(aliases.userId, request.userId),
          eq(aliases.canonicalNodeId, nodeId),
        ),
      ),
    tx
      .update(nodeRedirects)
      .set({ partitionKey: request.targetPartitionKey })
      .where(
        and(
          eq(nodeRedirects.userId, request.userId),
          eq(nodeRedirects.toNodeId, nodeId),
        ),
      ),
  ]);
}

async function rewireSourceEvidence(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
  sourceIds: TypeId<"source">[],
  mappings: PartitionNodeMapping[],
): Promise<Array<{ id: TypeId<"claim"> }>> {
  for (const mapping of mappings) {
    await tx
      .update(sourceLinks)
      .set({ nodeId: mapping.replacementNodeId })
      .where(
        and(
          inArray(sourceLinks.sourceId, sourceIds),
          eq(sourceLinks.nodeId, mapping.sourceNodeId),
        ),
      );
  }

  const replacement = (column: AnyPgColumn) =>
    mappings.length === 0
      ? column
      : sql`CASE ${sql.join(
          mappings.map(
            (mapping) =>
              sql`WHEN ${column} = ${mapping.sourceNodeId} THEN ${mapping.replacementNodeId}`,
          ),
          sql` `,
        )} ELSE ${column} END`;

  return tx
    .update(claims)
    .set({
      partitionKey: request.targetPartitionKey,
      subjectNodeId: replacement(claims.subjectNodeId),
      objectNodeId: replacement(claims.objectNodeId),
      assertedByNodeId: replacement(claims.assertedByNodeId),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(claims.userId, request.userId),
        inArray(claims.sourceId, sourceIds),
      ),
    )
    .returning({ id: claims.id });
}

async function nodeHasOtherPartitionSupport(
  tx: Transaction,
  request: ReclassifySourcePartitionRequest,
  movedSourceIds: TypeId<"source">[],
  nodeId: TypeId<"node">,
): Promise<boolean> {
  const result = await tx.execute<{ has_other_support: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${sourceLinks} sl JOIN ${sources} s ON s.id = sl.source_id
      WHERE sl.node_id = ${nodeId} AND s.user_id = ${request.userId}
        AND s.id NOT IN (${sql.join(
          movedSourceIds.map((sourceId) => sql`${sourceId}`),
          sql`, `,
        )})
        AND s.partition_key IS DISTINCT FROM ${request.targetPartitionKey}
      UNION ALL
      SELECT 1 FROM ${claims} c
      WHERE c.user_id = ${request.userId} AND c.source_id NOT IN (${sql.join(
        movedSourceIds.map((sourceId) => sql`${sourceId}`),
        sql`, `,
      )})
        AND (${nodeId} IN (c.subject_node_id, c.object_node_id, c.asserted_by_node_id))
        AND c.partition_key IS DISTINCT FROM ${request.targetPartitionKey}
    ) AS has_other_support
  `);
  return result.rows[0]?.has_other_support === true;
}

async function loadCommand(
  tx: Transaction,
  userId: string,
  bindingGeneration: string,
) {
  const [row] = await tx
    .select()
    .from(sourcePartitionCommands)
    .where(
      and(
        eq(sourcePartitionCommands.userId, userId),
        eq(sourcePartitionCommands.bindingGeneration, bindingGeneration),
      ),
    )
    .limit(1);
  return row
    ? {
        ...row,
        sourceIds: typeIdSchema("source").array().parse(row.sourceIds),
        nodeMappings: partitionNodeMappingSchema
          .array()
          .parse(row.nodeMappings),
      }
    : null;
}

function commandResponse(
  command: NonNullable<Awaited<ReturnType<typeof loadCommand>>>,
  replayed: boolean,
): ReclassifySourcePartitionResponse {
  return {
    sourceId: command.sourceId,
    partitionKey: command.targetPartitionKey,
    sourceVersion: command.sourceVersion,
    bindingGeneration: command.bindingGeneration,
    replayed,
    movedClaimCount: command.movedClaimCount,
    nodeMappings: command.nodeMappings,
  };
}

function replayCommand(
  request: ReclassifySourcePartitionRequest,
  command: NonNullable<Awaited<ReturnType<typeof loadCommand>>>,
  currentSourceIds: TypeId<"source">[] | null,
): ReclassifySourcePartitionResponse {
  if (
    command.sourceId !== request.sourceId ||
    command.expectedPartitionKey !== request.expectedPartitionKey ||
    command.targetPartitionKey !== request.targetPartitionKey ||
    command.expectedSourceVersion !== request.expectedSourceVersion
  ) {
    throw new PartitionReclassificationError(
      "BINDING_GENERATION_CONFLICT",
      "Binding generation was already used for different migration intent",
      {
        sourcePartitionKey: command.targetPartitionKey,
        sourceVersion: command.sourceVersion,
      },
    );
  }
  if (
    currentSourceIds !== null &&
    !sameSourceIds(currentSourceIds, command.sourceIds)
  ) {
    throw new PartitionReclassificationError(
      "BINDING_GENERATION_CONFLICT",
      "Binding generation no longer describes the same parent/child source tree",
      {
        sourcePartitionKey: command.targetPartitionKey,
        sourceVersion: command.sourceVersion,
      },
    );
  }
  return commandResponse(command, true);
}

function sameSourceIds(
  left: TypeId<"source">[],
  right: TypeId<"source">[],
): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((sourceId, index) => sourceId === sortedRight[index])
  );
}
