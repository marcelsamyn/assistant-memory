/** Maintenance-only source erasure. No source content crosses this boundary. */
import { and, asc, eq, inArray, notExists, or, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  commitmentPresentations,
  metricDefinitionEmbeddings,
  metricDefinitions,
  metricObservations,
  memoryChangeFeedEvents,
  nodeEmbeddings,
  nodeMetadata,
  nodeRedirects,
  nodes,
  partitionArtifactReceipts,
  partitionNodeMappings,
  rollupState,
  sourceBlobUploads,
  sourceLifecycleCommands,
  sourceLinks,
  sourcePartitionCommands,
  sourceTombstones,
  sources,
  userProfiles,
} from "~/db/schema";
import { purgeSourceIngestionOperations } from "~/lib/ingestion/source-processing";
import { lockSourceParentAttachmentGates } from "~/lib/partition-access";
import {
  partitionNodeMappingSchema,
  type ContextPartitionKey,
} from "~/lib/schemas/partition";
import type {
  SourceLifecycleCommandRequest,
  SourceLifecycleCommandResponse,
  SourceLifecycleReadModelRetractionSweepResponse,
  SourceLifecycleState,
  SourceLifecycleStorageCleanupSweepResponse,
  SourceStorageCleanupState,
} from "~/lib/schemas/source-lifecycle";
import { sourceBlobObjectKey } from "~/lib/sources";
import { typeIdFromString, typeIdSchema, type TypeId } from "~/types/typeid";

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
type Transaction = Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];

export type SourceLifecycleErrorCode =
  | "SOURCE_NOT_FOUND"
  | "SOURCE_VERSION_CONFLICT"
  | "SOURCE_PARTITION_CONFLICT"
  | "SOURCE_LIFECYCLE_COMMAND_CONFLICT"
  | "SOURCE_LIFECYCLE_STATE_CONFLICT"
  | "SOURCE_RESTORE_WINDOW_EXPIRED";

export class SourceLifecycleError extends Error {
  constructor(
    readonly code: SourceLifecycleErrorCode,
    message: string,
    readonly current: {
      sourcePartitionKey?: ContextPartitionKey | null;
      sourceVersion?: number | null;
      state?: SourceLifecycleState;
      restorableUntil?: Date | null;
    } = {},
  ) {
    super(message);
    this.name = "SourceLifecycleError";
  }
}

/**
 * Applies a caller-idempotent source deletion transition. Tombstoning erases
 * inline descriptors and graph evidence before the transaction commits;
 * restore deletes the old row so only a subsequent new ingestion can return.
 */
export async function applySourceLifecycleCommand(
  db: DrizzleDB,
  request: SourceLifecycleCommandRequest,
): Promise<SourceLifecycleCommandResponse> {
  return db.transaction(async (tx) => {
    const replay = await loadCommand(tx, request.userId, request.commandId);
    if (replay) return replayCommand(request, replay);

    const sourceTree = await loadAndLockSourceTree(
      tx,
      request.userId,
      request.sourceId,
    );
    const source = sourceTree.find((row) => row.id === request.sourceId);
    if (!source || sourceTree.length === 0) {
      throw new SourceLifecycleError(
        "SOURCE_NOT_FOUND",
        "Source was not found for this user",
      );
    }
    // Another transaction may have claimed this command while this one waited
    // on the source authority lock. Re-read before comparing the now-advanced
    // source version so concurrent same-key retries replay rather than fail.
    const concurrentReplay = await loadCommand(
      tx,
      request.userId,
      request.commandId,
    );
    if (concurrentReplay) return replayCommand(request, concurrentReplay);
    assertExpectedSource(source, request);

    const [tombstone] = await tx
      .select()
      .from(sourceTombstones)
      .where(
        and(
          eq(sourceTombstones.userId, request.userId),
          eq(sourceTombstones.sourceId, request.sourceId),
        ),
      )
      .for("update")
      .limit(1);

    const result = await applyAction(
      tx,
      request,
      source,
      sourceTree,
      tombstone ?? null,
    );
    const storageObjectKeys = await storageCleanupObjectKeys(
      tx,
      request,
      sourceTree,
    );
    await tx.insert(sourceLifecycleCommands).values({
      userId: request.userId,
      commandId: request.commandId,
      sourceId: request.sourceId,
      expectedPartitionKey: request.expectedPartitionKey,
      expectedSourceVersion: request.expectedSourceVersion,
      action: request.action,
      state: result.state,
      sourceVersion: result.sourceVersion,
      restorableUntil: result.restorableUntil,
      storageCleanupState: result.storageCleanupState,
      storageObjectKeys,
    });
    return result;
  });
}

type LockedSource = {
  id: SourceLifecycleCommandRequest["sourceId"];
  partitionKey: ContextPartitionKey | null;
  version: number;
  deletedAt: Date | null;
  contentType: string | null;
  contentLength: number | null;
};
type Tombstone = typeof sourceTombstones.$inferSelect;

/**
 * `parentSource` models containment, not just a display relationship: a
 * conversation/transcript parent owns every message below it. Lifecycle
 * deletion therefore locks the complete descendant tree before touching any
 * content-bearing read model. The root is locked by the caller first; sorting
 * the remaining ids gives concurrent root operations a consistent lock order.
 */
async function loadAndLockSourceTree(
  tx: Transaction,
  userId: string,
  rootSourceId: SourceLifecycleCommandRequest["sourceId"],
): Promise<LockedSource[]> {
  const findSourceTreeIds = async (): Promise<TypeId<"source">[]> => {
    const result = await tx.execute<{ source_id: string }>(sql`
    WITH RECURSIVE source_tree(source_id) AS (
      SELECT id
      FROM ${sources}
      WHERE user_id = ${userId} AND id = ${rootSourceId}
      UNION
      SELECT child.id
      FROM ${sources} child
      JOIN source_tree parent ON child.parent_source = parent.source_id
      WHERE child.user_id = ${userId}
    )
    SELECT source_id FROM source_tree ORDER BY source_id
  `);
    return result.rows.map((row) => typeIdFromString("source", row.source_id));
  };

  // Closing a tree is a two-boundary operation: source rows are locked only
  // after all current parents share an advisory attachment gate with inserts.
  // Re-discovery covers a child committed between the first recursive query
  // and acquisition of its parent gate; once every discovered parent is
  // gated, no further descendant can attach until this transaction finishes.
  let sourceIds = await findSourceTreeIds();
  while (true) {
    await lockSourceParentAttachmentGates(
      tx,
      sourceIds.map((sourceId) => ({ userId, sourceId })),
    );
    const rediscoveredSourceIds = await findSourceTreeIds();
    if (
      rediscoveredSourceIds.length === sourceIds.length &&
      rediscoveredSourceIds.every(
        (sourceId, index) => sourceId === sourceIds[index],
      )
    ) {
      sourceIds = rediscoveredSourceIds;
      break;
    }
    sourceIds = rediscoveredSourceIds;
  }

  if (sourceIds.length === 0) return [];

  const rows = await tx
    .select({
      id: sources.id,
      partitionKey: sources.partitionKey,
      version: sources.version,
      deletedAt: sources.deletedAt,
      contentType: sources.contentType,
      contentLength: sources.contentLength,
    })
    .from(sources)
    .where(and(eq(sources.userId, userId), inArray(sources.id, sourceIds)))
    .orderBy(asc(sources.id))
    .for("update");
  if (rows.length !== sourceIds.length) {
    throw new SourceLifecycleError(
      "SOURCE_NOT_FOUND",
      "A descendant source disappeared while locking the source tree",
    );
  }
  return rows;
}

function assertExpectedSource(
  source: LockedSource,
  request: SourceLifecycleCommandRequest,
): void {
  if (source.partitionKey !== request.expectedPartitionKey) {
    throw new SourceLifecycleError(
      "SOURCE_PARTITION_CONFLICT",
      "Source partition changed before the lifecycle command was applied",
      {
        sourcePartitionKey: source.partitionKey,
        sourceVersion: source.version,
      },
    );
  }
  if (source.version !== request.expectedSourceVersion) {
    throw new SourceLifecycleError(
      "SOURCE_VERSION_CONFLICT",
      `Source version changed: expected ${request.expectedSourceVersion}, found ${source.version}`,
      {
        sourcePartitionKey: source.partitionKey,
        sourceVersion: source.version,
      },
    );
  }
}

async function applyAction(
  tx: Transaction,
  request: SourceLifecycleCommandRequest,
  source: LockedSource,
  sourceTree: LockedSource[],
  tombstone: Tombstone | null,
): Promise<SourceLifecycleCommandResponse> {
  if (request.action === "tombstone") {
    if (source.deletedAt !== null || tombstone !== null) {
      throw stateConflict(
        tombstone,
        "Source is already tombstoned or finalized",
      );
    }
    const erasedAt = new Date();
    const restorableUntil = new Date(erasedAt.getTime() + RESTORE_WINDOW_MS);
    // Always capture/delete the deterministic object key. A raw upload can
    // succeed just before its descriptor write loses the lifecycle race; the
    // descriptor alone is therefore not proof that no object exists.
    const storageCleanupState: SourceStorageCleanupState = "pending";
    const sourceIds = sourceTree.map((treeSource) => treeSource.id);
    await eraseSourceReadModels(tx, request.userId, sourceIds);
    const updatedSources = await Promise.all(
      sourceTree.map(async (treeSource) => {
        if (treeSource.deletedAt !== null) return treeSource;
        const [updated] = await tx
          .update(sources)
          .set({
            metadata: {},
            contentType: null,
            contentLength: null,
            deletedAt: erasedAt,
          })
          .where(
            and(
              eq(sources.userId, request.userId),
              eq(sources.id, treeSource.id),
              eq(sources.version, treeSource.version),
            ),
          )
          .returning({ id: sources.id, version: sources.version });
        if (!updated) {
          throw new SourceLifecycleError(
            "SOURCE_VERSION_CONFLICT",
            "A descendant source changed while the lifecycle command was applying",
          );
        }
        return updated;
      }),
    );
    const updated = updatedSources.find(
      (treeSource) => treeSource.id === request.sourceId,
    );
    if (!updated) throw new Error("Locked source disappeared during tombstone");
    // This locks any committed external upload reservation while the complete
    // source tree is already locked. An uploader either finishes its put under
    // the same authority first, or observes cleanup_pending and never sends
    // bytes. The tombstone receipt cannot terminally complete ahead of it.
    await requestSourceBlobUploadCleanup(tx, request.userId, sourceIds);
    await tx
      .insert(sourceTombstones)
      .values(
        sourceTree.map((treeSource) => ({
          userId: request.userId,
          sourceId: treeSource.id,
          partitionKey: treeSource.partitionKey,
          state: "tombstoned" as const,
          storageCleanupState: "pending" as const,
          storageObjectKey: sourceBlobObjectKey(request.userId, treeSource.id),
          erasedAt,
          restorableUntil,
        })),
      )
      .onConflictDoNothing({
        target: [sourceTombstones.userId, sourceTombstones.sourceId],
      });
    return response(
      request,
      "tombstoned",
      false,
      updated.version,
      restorableUntil,
      storageCleanupState,
    );
  }

  if (!tombstone) {
    throw stateConflict(null, "Source has not been tombstoned");
  }

  if (request.action === "restore") {
    if (
      tombstone.state !== "tombstoned" ||
      tombstone.restorableUntil === null
    ) {
      throw stateConflict(
        tombstone,
        "Source cannot be restored from its current lifecycle state",
      );
    }
    if (tombstone.restorableUntil < new Date()) {
      throw new SourceLifecycleError(
        "SOURCE_RESTORE_WINDOW_EXPIRED",
        "The source restore window has expired; use a fresh ingestion instead",
        { state: tombstone.state, restorableUntil: tombstone.restorableUntil },
      );
    }
    // Deleting the blank old row releases its (user, type, external id) unique
    // slot. The historical tombstone stays, so a fresh source gets a new id.
    const sourceIds = sourceTree.map((treeSource) => treeSource.id);
    await tx
      .delete(sources)
      .where(
        and(eq(sources.userId, request.userId), inArray(sources.id, sourceIds)),
      );
    const finalizedAt = new Date();
    await tx
      .update(sourceTombstones)
      .set({ state: "restored", finalizedAt, updatedAt: finalizedAt })
      .where(
        and(
          eq(sourceTombstones.userId, request.userId),
          inArray(sourceTombstones.sourceId, sourceIds),
        ),
      );
    return response(
      request,
      "restored",
      true,
      null,
      tombstone.restorableUntil,
      tombstone.storageCleanupState,
    );
  }

  if (tombstone.state === "purged") {
    throw stateConflict(tombstone, "Source has already been purged");
  }
  const sourceIds = sourceTree.map((treeSource) => treeSource.id);
  await purgeSourceIngestionOperations(tx, request.userId, sourceIds);
  await tx
    .delete(sources)
    .where(
      and(eq(sources.userId, request.userId), inArray(sources.id, sourceIds)),
    );
  const finalizedAt = new Date();
  await tx
    .update(sourceTombstones)
    .set({
      state: "purged",
      finalizedAt,
      restorableUntil: null,
      updatedAt: finalizedAt,
    })
    .where(
      and(
        eq(sourceTombstones.userId, request.userId),
        inArray(sourceTombstones.sourceId, sourceIds),
      ),
    );
  return response(
    request,
    "purged",
    false,
    null,
    null,
    tombstone.storageCleanupState,
  );
}

/**
 * Transitions committed uploads to durable cleanup after their source locks
 * have been acquired. There is intentionally no FK: a purge must preserve the
 * object-store authority while the original source row is gone.
 */
async function requestSourceBlobUploadCleanup(
  tx: Transaction,
  userId: string,
  sourceIds: TypeId<"source">[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  const uploads = await tx
    .select({
      sourceId: sourceBlobUploads.sourceId,
      state: sourceBlobUploads.state,
    })
    .from(sourceBlobUploads)
    .where(
      and(
        eq(sourceBlobUploads.userId, userId),
        inArray(sourceBlobUploads.sourceId, sourceIds),
      ),
    )
    .orderBy(sourceBlobUploads.sourceId)
    .for("update");
  const pendingIds = uploads
    .filter(
      (upload) =>
        upload.state !== "cleanup_completed" &&
        upload.state !== "upload_unknown",
    )
    .map((upload) => upload.sourceId);
  if (pendingIds.length === 0) return;
  await tx
    .update(sourceBlobUploads)
    .set({ state: "cleanup_pending", updatedAt: new Date() })
    .where(
      and(
        eq(sourceBlobUploads.userId, userId),
        inArray(sourceBlobUploads.sourceId, pendingIds),
      ),
    );
}

/**
 * Erases the partition-split graph rooted in a deleted source before the
 * source links disappear. Partition mappings deliberately have no source or
 * node foreign keys because recovery must survive ordinary reclassification;
 * that makes this lifecycle boundary their explicit owner instead.
 *
 * A replacement can be referenced by a newer mapping or a replay receipt.
 * We retain only its directly-proven live source links/claims, then invalidate
 * every mapping, receipt, and presentation artifact that could otherwise let
 * a deleted source revive its copied label or partition identity.
 */
async function erasePartitionDerivatives(
  tx: Transaction,
  userId: string,
  sourceIds: TypeId<"source">[],
  linkedNodeIds: TypeId<"node">[],
): Promise<TypeId<"node">[]> {
  const [mappings, commands] = await Promise.all([
    tx
      .select({
        sourceNodeId: partitionNodeMappings.sourceNodeId,
        partitionKey: partitionNodeMappings.partitionKey,
        replacementNodeId: partitionNodeMappings.replacementNodeId,
        sourceId: partitionNodeMappings.sourceId,
      })
      .from(partitionNodeMappings)
      .where(eq(partitionNodeMappings.userId, userId))
      .for("update"),
    tx
      .select({
        bindingGeneration: sourcePartitionCommands.bindingGeneration,
        sourceId: sourcePartitionCommands.sourceId,
        sourceIds: sourcePartitionCommands.sourceIds,
        nodeMappings: sourcePartitionCommands.nodeMappings,
      })
      .from(sourcePartitionCommands)
      .where(eq(sourcePartitionCommands.userId, userId))
      .for("update"),
  ]);
  const parsedCommands = commands.map((command) => ({
    ...command,
    sourceIds: typeIdSchema("source").array().parse(command.sourceIds),
    nodeMappings: partitionNodeMappingSchema
      .array()
      .parse(command.nodeMappings),
  }));
  const deletedSourceIds = new Set(sourceIds);
  const affectedNodeIds = new Set(linkedNodeIds);
  const affectedMappings = new Set<number>();
  const affectedCommands = new Set<number>();

  // Walk both durable directions to a fixed point: the mutable mapping table
  // and immutable command snapshots can each be the only remaining edge after
  // an interrupted recovery. Deleting only one direction leaves an old replay
  // path that can return a replacement after the source is gone.
  let changed = true;
  while (changed) {
    changed = false;
    mappings.forEach((mapping, index) => {
      const touchesDeletedSource = deletedSourceIds.has(mapping.sourceId);
      const touchesAffectedNode =
        affectedNodeIds.has(mapping.sourceNodeId) ||
        (mapping.replacementNodeId !== null &&
          affectedNodeIds.has(mapping.replacementNodeId));
      if (!touchesDeletedSource && !touchesAffectedNode) return;
      if (!affectedMappings.has(index)) {
        affectedMappings.add(index);
        changed = true;
      }
      for (const nodeId of [
        mapping.sourceNodeId,
        ...(mapping.replacementNodeId ? [mapping.replacementNodeId] : []),
      ]) {
        if (!affectedNodeIds.has(nodeId)) {
          affectedNodeIds.add(nodeId);
          changed = true;
        }
      }
    });
    parsedCommands.forEach((command, index) => {
      const touchesDeletedSource =
        deletedSourceIds.has(command.sourceId) ||
        command.sourceIds.some((sourceId) => deletedSourceIds.has(sourceId));
      const touchesAffectedNode = command.nodeMappings.some(
        (mapping) =>
          affectedNodeIds.has(mapping.sourceNodeId) ||
          affectedNodeIds.has(mapping.replacementNodeId),
      );
      if (!touchesDeletedSource && !touchesAffectedNode) return;
      if (!affectedCommands.has(index)) {
        affectedCommands.add(index);
        changed = true;
      }
      for (const mapping of command.nodeMappings) {
        for (const nodeId of [
          mapping.sourceNodeId,
          mapping.replacementNodeId,
        ]) {
          if (!affectedNodeIds.has(nodeId)) {
            affectedNodeIds.add(nodeId);
            changed = true;
          }
        }
      }
    });
  }

  const receiptKeys = new Map<
    string,
    {
      sourceNodeId: TypeId<"node">;
      partitionKey: ContextPartitionKey;
    }
  >();
  for (const index of affectedMappings) {
    const mapping = mappings[index];
    if (!mapping) continue;
    receiptKeys.set(`${mapping.sourceNodeId}\u001f${mapping.partitionKey}`, {
      sourceNodeId: mapping.sourceNodeId,
      partitionKey: mapping.partitionKey,
    });
  }
  for (const index of affectedCommands) {
    const command = parsedCommands[index];
    if (!command) continue;
    for (const mapping of command.nodeMappings) {
      receiptKeys.set(`${mapping.sourceNodeId}\u001f${mapping.partitionKey}`, {
        sourceNodeId: mapping.sourceNodeId,
        partitionKey: mapping.partitionKey,
      });
    }
  }

  // Receipt-deletion integrity requires its completed mapping to be gone
  // first. Exact primary-key deletes avoid touching an unrelated partition of
  // the same original node.
  for (const index of affectedMappings) {
    const mapping = mappings[index];
    if (!mapping) continue;
    await tx
      .delete(partitionNodeMappings)
      .where(
        and(
          eq(partitionNodeMappings.userId, userId),
          eq(partitionNodeMappings.sourceNodeId, mapping.sourceNodeId),
          eq(partitionNodeMappings.partitionKey, mapping.partitionKey),
        ),
      );
  }
  for (const receipt of receiptKeys.values()) {
    await tx
      .delete(partitionArtifactReceipts)
      .where(
        and(
          eq(partitionArtifactReceipts.userId, userId),
          eq(partitionArtifactReceipts.sourceNodeId, receipt.sourceNodeId),
          eq(partitionArtifactReceipts.partitionKey, receipt.partitionKey),
        ),
      );
  }
  for (const index of affectedCommands) {
    const command = parsedCommands[index];
    if (!command) continue;
    await tx
      .delete(sourcePartitionCommands)
      .where(
        and(
          eq(sourcePartitionCommands.userId, userId),
          eq(
            sourcePartitionCommands.bindingGeneration,
            command.bindingGeneration,
          ),
        ),
      );
  }
  return [...affectedNodeIds];
}

/**
 * Metric review tasks are generated solely to resolve a proposed definition.
 * Once its unsupported definition is erased, remove the task's own graph
 * projections too, but only when no surviving definition still references it.
 */
async function eraseMetricDefinitionReviewArtifacts(
  tx: Transaction,
  userId: string,
  candidateNodeIds: TypeId<"node">[],
): Promise<void> {
  const uniqueCandidateNodeIds = [...new Set(candidateNodeIds)];
  if (uniqueCandidateNodeIds.length === 0) return;

  const reviewNodes = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.userId, userId),
        inArray(nodes.id, uniqueCandidateNodeIds),
        notExists(
          tx
            .select({ id: metricDefinitions.id })
            .from(metricDefinitions)
            .where(eq(metricDefinitions.reviewTaskNodeId, nodes.id)),
        ),
        // `createNode` gives system-generated review tasks the user's generic
        // manual source link. That records their creation mechanics, not
        // independent evidence for the proposed metric. A non-manual link is
        // still a real ownership path and must keep the node intact.
        notExists(
          tx
            .select({ id: sourceLinks.id })
            .from(sourceLinks)
            .innerJoin(sources, eq(sourceLinks.sourceId, sources.id))
            .where(
              and(
                eq(sourceLinks.nodeId, nodes.id),
                sql`${sources.type} <> 'manual'`,
              ),
            ),
        ),
      ),
    );
  const reviewNodeIds = reviewNodes.map((node) => node.id);
  if (reviewNodeIds.length === 0) return;

  // Capture the rows whose DELETE triggers would otherwise append the review
  // task's label and claim text to the immutable-looking change feed. The
  // generic manual source remains live for the user, so source-level
  // redaction cannot cover these derived artifacts.
  const [reviewClaims, reviewLinks] = await Promise.all([
    tx
      .select({ id: claims.id })
      .from(claims)
      .where(
        and(
          eq(claims.userId, userId),
          or(
            inArray(claims.subjectNodeId, reviewNodeIds),
            inArray(claims.objectNodeId, reviewNodeIds),
            inArray(claims.assertedByNodeId, reviewNodeIds),
          ),
        ),
      ),
    tx
      .select({ id: sourceLinks.id })
      .from(sourceLinks)
      .where(inArray(sourceLinks.nodeId, reviewNodeIds)),
  ]);

  await tx
    .delete(claims)
    .where(
      and(
        eq(claims.userId, userId),
        or(
          inArray(claims.subjectNodeId, reviewNodeIds),
          inArray(claims.objectNodeId, reviewNodeIds),
          inArray(claims.assertedByNodeId, reviewNodeIds),
        ),
      ),
    );
  await Promise.all([
    tx.delete(nodeMetadata).where(inArray(nodeMetadata.nodeId, reviewNodeIds)),
    tx
      .delete(nodeEmbeddings)
      .where(inArray(nodeEmbeddings.nodeId, reviewNodeIds)),
    tx
      .delete(aliases)
      .where(
        and(
          eq(aliases.userId, userId),
          inArray(aliases.canonicalNodeId, reviewNodeIds),
        ),
      ),
    tx
      .delete(nodeRedirects)
      .where(
        and(
          eq(nodeRedirects.userId, userId),
          or(
            inArray(nodeRedirects.toNodeId, reviewNodeIds),
            inArray(nodeRedirects.fromNodeId, reviewNodeIds),
          ),
        ),
      ),
  ]);
  await tx
    .delete(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, reviewNodeIds)));
  await redactReviewArtifactFeedEvents(
    tx,
    userId,
    reviewNodeIds,
    reviewClaims.map((claim) => claim.id),
    reviewLinks.map((link) => link.id),
  );
}

/** Erases source-derived review task payloads while preserving feed sequence. */
async function redactReviewArtifactFeedEvents(
  tx: Transaction,
  userId: string,
  reviewNodeIds: TypeId<"node">[],
  reviewClaimIds: TypeId<"claim">[],
  reviewLinkIds: TypeId<"source_link">[],
): Promise<void> {
  await tx
    .update(memoryChangeFeedEvents)
    .set({
      payload: { redacted: true, sourceDerivedReviewArtifact: true },
      provenance: null,
      freshness: null,
      status: "tombstoned",
    })
    .where(
      and(
        eq(memoryChangeFeedEvents.userId, userId),
        or(
          and(
            inArray(memoryChangeFeedEvents.entityType, ["node", "commitment"]),
            inArray(memoryChangeFeedEvents.entityId, reviewNodeIds),
          ),
          reviewClaimIds.length === 0
            ? undefined
            : and(
                eq(memoryChangeFeedEvents.entityType, "claim"),
                inArray(memoryChangeFeedEvents.entityId, reviewClaimIds),
              ),
          reviewLinkIds.length === 0
            ? undefined
            : and(
                eq(memoryChangeFeedEvents.entityType, "source_link"),
                inArray(memoryChangeFeedEvents.entityId, reviewLinkIds),
              ),
        ),
      ),
    );
}

async function eraseSourceReadModels(
  tx: Transaction,
  userId: string,
  sourceIds: TypeId<"source">[],
): Promise<void> {
  const [linkedNodes, sourceClaims, sourcedMetricDefinitions] =
    await Promise.all([
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
          and(eq(claims.userId, userId), inArray(claims.sourceId, sourceIds)),
        ),
      tx
        .select({
          id: metricDefinitions.id,
          reviewTaskNodeId: metricDefinitions.reviewTaskNodeId,
        })
        .from(metricObservations)
        .innerJoin(
          metricDefinitions,
          eq(metricObservations.metricDefinitionId, metricDefinitions.id),
        )
        .where(
          and(
            eq(metricObservations.userId, userId),
            inArray(metricObservations.sourceId, sourceIds),
          ),
        ),
    ]);
  // A source assertion can be the only provenance path to a shared node. Its
  // labels, aliases, metadata, and embedding are just as sensitive as a
  // source_link-backed node, so discover every claim role before deleting the
  // claim records that reveal it.
  const sourceClaimNodeIds = sourceClaims.flatMap((claim) =>
    [claim.subjectNodeId, claim.objectNodeId, claim.assertedByNodeId].filter(
      (nodeId): nodeId is TypeId<"node"> => nodeId !== null,
    ),
  );
  const nodeIds = await erasePartitionDerivatives(tx, userId, sourceIds, [
    ...new Set([
      ...linkedNodes.map((row) => row.nodeId),
      ...sourceClaimNodeIds,
    ]),
  ]);
  const metricDefinitionIds = [
    ...new Set(sourcedMetricDefinitions.map((definition) => definition.id)),
  ];
  // Independent source tombstones can each remove the last observation for
  // one definition. Lock every candidate in a stable order before either
  // transaction removes observations, then re-read the locked rows. At Read
  // Committed this makes the second tombstone observe the first one's commit
  // before deciding whether the definition remains supported.
  const lockedMetricDefinitions =
    metricDefinitionIds.length === 0
      ? []
      : await tx
          .select({
            id: metricDefinitions.id,
            reviewTaskNodeId: metricDefinitions.reviewTaskNodeId,
          })
          .from(metricDefinitions)
          .where(
            and(
              eq(metricDefinitions.userId, userId),
              inArray(metricDefinitions.id, metricDefinitionIds),
            ),
          )
          .orderBy(asc(metricDefinitions.id))
          .for("update");
  await tx
    .delete(metricObservations)
    .where(
      and(
        eq(metricObservations.userId, userId),
        inArray(metricObservations.sourceId, sourceIds),
      ),
    );

  const lockedMetricDefinitionIds = lockedMetricDefinitions.map(
    (definition) => definition.id,
  );
  if (lockedMetricDefinitionIds.length > 0) {
    // A definition created for source-derived observations is itself a
    // read-model artifact. Keep it only when another live observation still
    // supports it; otherwise remove its vector and review task with it.
    const unsupportedDefinitions = await tx
      .select({
        id: metricDefinitions.id,
        reviewTaskNodeId: metricDefinitions.reviewTaskNodeId,
      })
      .from(metricDefinitions)
      .where(
        and(
          eq(metricDefinitions.userId, userId),
          inArray(metricDefinitions.id, lockedMetricDefinitionIds),
          notExists(
            tx
              .select({ id: metricObservations.id })
              .from(metricObservations)
              .where(
                and(
                  eq(
                    metricObservations.metricDefinitionId,
                    metricDefinitions.id,
                  ),
                  eq(metricObservations.userId, userId),
                ),
              ),
          ),
        ),
      );
    const unsupportedDefinitionIds = unsupportedDefinitions.map(
      (definition) => definition.id,
    );
    if (unsupportedDefinitionIds.length > 0) {
      await tx
        .delete(metricDefinitionEmbeddings)
        .where(
          inArray(
            metricDefinitionEmbeddings.metricDefinitionId,
            unsupportedDefinitionIds,
          ),
        );
      await tx
        .delete(metricDefinitions)
        .where(
          and(
            eq(metricDefinitions.userId, userId),
            inArray(metricDefinitions.id, unsupportedDefinitionIds),
          ),
        );
      await eraseMetricDefinitionReviewArtifacts(
        tx,
        userId,
        unsupportedDefinitions.flatMap((definition) =>
          definition.reviewTaskNodeId === null
            ? []
            : [definition.reviewTaskNodeId],
        ),
      );
    }
  }

  await Promise.all([
    tx
      .delete(claims)
      .where(
        and(eq(claims.userId, userId), inArray(claims.sourceId, sourceIds)),
      ),
    tx.delete(sourceLinks).where(inArray(sourceLinks.sourceId, sourceIds)),
    tx
      .delete(commitmentPresentations)
      .where(
        and(
          eq(commitmentPresentations.userId, userId),
          inArray(commitmentPresentations.sourceId, sourceIds),
        ),
      ),
  ]);
  if (nodeIds.length > 0) {
    // Node labels, descriptions, aliases, and embeddings do not carry a
    // source-level provenance ledger. For a shared node, retaining any of
    // those projections could expose the erased source, so invalidate them
    // conservatively; later live-source extraction rebuilds them.
    await Promise.all([
      tx.delete(nodeMetadata).where(inArray(nodeMetadata.nodeId, nodeIds)),
      tx.delete(nodeEmbeddings).where(inArray(nodeEmbeddings.nodeId, nodeIds)),
      tx
        .delete(nodeRedirects)
        .where(
          and(
            eq(nodeRedirects.userId, userId),
            or(
              inArray(nodeRedirects.toNodeId, nodeIds),
              inArray(nodeRedirects.fromNodeId, nodeIds),
            ),
          ),
        ),
      tx
        .delete(aliases)
        .where(
          and(
            eq(aliases.userId, userId),
            inArray(aliases.canonicalNodeId, nodeIds),
          ),
        ),
    ]);
    const orphanNodes = await tx
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.userId, userId),
          inArray(nodes.id, nodeIds),
          notExists(
            tx
              .select({ id: sourceLinks.id })
              .from(sourceLinks)
              .where(eq(sourceLinks.nodeId, nodes.id)),
          ),
          notExists(
            tx
              .select({ id: claims.id })
              .from(claims)
              .where(
                sql`${claims.subjectNodeId} = ${nodes.id} OR ${claims.objectNodeId} = ${nodes.id} OR ${claims.assertedByNodeId} = ${nodes.id}`,
              ),
          ),
        ),
      );
    const orphanNodeIds = orphanNodes.map((node) => node.id);
    if (orphanNodeIds.length > 0) {
      await tx
        .delete(nodes)
        .where(and(eq(nodes.userId, userId), inArray(nodes.id, orphanNodeIds)));
    }
  }
  // These are user/partition-derived narrative projections with no source FK.
  // Conservatively remove them so they cannot retain deleted-source language.
  await Promise.all([
    tx.delete(userProfiles).where(eq(userProfiles.userId, userId)),
    tx.delete(rollupState).where(eq(rollupState.userId, userId)),
  ]);
}

function response(
  request: SourceLifecycleCommandRequest,
  state: SourceLifecycleState,
  freshIngestionRequired: boolean,
  sourceVersion: number | null,
  restorableUntil: Date | null,
  storageCleanupState: SourceStorageCleanupState,
): SourceLifecycleCommandResponse {
  return {
    sourceId: request.sourceId,
    commandId: request.commandId,
    action: request.action,
    state,
    replayed: false,
    freshIngestionRequired,
    sourceVersion,
    restorableUntil,
    storageCleanupState,
  };
}

async function loadCommand(
  tx: Transaction,
  userId: string,
  commandId: string,
): Promise<typeof sourceLifecycleCommands.$inferSelect | null> {
  const [command] = await tx
    .select()
    .from(sourceLifecycleCommands)
    .where(
      and(
        eq(sourceLifecycleCommands.userId, userId),
        eq(sourceLifecycleCommands.commandId, commandId),
      ),
    )
    .limit(1);
  return command ?? null;
}

function replayCommand(
  request: SourceLifecycleCommandRequest,
  command: typeof sourceLifecycleCommands.$inferSelect,
): SourceLifecycleCommandResponse {
  if (
    command.sourceId !== request.sourceId ||
    command.action !== request.action ||
    command.expectedPartitionKey !== request.expectedPartitionKey ||
    command.expectedSourceVersion !== request.expectedSourceVersion
  ) {
    throw new SourceLifecycleError(
      "SOURCE_LIFECYCLE_COMMAND_CONFLICT",
      "Lifecycle command id was already used with different source authority",
    );
  }
  return {
    sourceId: command.sourceId,
    commandId: command.commandId,
    action: command.action,
    state: command.state,
    replayed: true,
    freshIngestionRequired: command.state === "restored",
    sourceVersion: command.sourceVersion,
    restorableUntil: command.restorableUntil,
    storageCleanupState: command.storageCleanupState,
  };
}

function stateConflict(
  tombstone: Tombstone | null,
  message: string,
): SourceLifecycleError {
  const current = tombstone
    ? { state: tombstone.state, restorableUntil: tombstone.restorableUntil }
    : {};
  return new SourceLifecycleError("SOURCE_LIFECYCLE_STATE_CONFLICT", message, {
    ...current,
  });
}

/** Common aliases: source erasure, source deletion, source lifecycle. */
export const executeSourceLifecycleCommand = applySourceLifecycleCommand;

type PendingLegacyReadModelRetraction = {
  userId: string;
  sourceId: TypeId<"source">;
};

/**
 * Claims one migrated soft-deleted root under its tombstone receipt lock. The
 * receipt is the only durable work authority here: pre-lifecycle deletions do
 * not have a command id or a viable source version to replay.
 */
async function claimPendingLegacyReadModelRetraction(
  tx: Transaction,
): Promise<PendingLegacyReadModelRetraction | null> {
  const result = await tx.execute<{ user_id: string; source_id: string }>(sql`
    SELECT tombstone.user_id, tombstone.source_id
    FROM ${sourceTombstones} AS tombstone
    JOIN ${sources} AS source
      ON source.user_id = tombstone.user_id
      AND source.id = tombstone.source_id
    WHERE tombstone.read_model_cleanup_state = 'pending'
      AND source.deleted_at IS NOT NULL
    ORDER BY tombstone.user_id, tombstone.source_id
    FOR UPDATE OF tombstone SKIP LOCKED
    LIMIT 1
  `);
  const row = result.rows[0];
  return row
    ? {
        userId: row.user_id,
        sourceId: typeIdFromString("source", row.source_id),
      }
    : null;
}

/**
 * Erases read models for one legacy root and its complete containment tree.
 * We intentionally make still-present descendants terminal too: retaining a
 * child projection would make the erased parent recoverable through a second
 * path. New descendant tombstones also schedule their opaque blobs for the
 * existing storage retry sweep.
 */
async function retractLegacySourceReadModels(
  tx: Transaction,
  entry: PendingLegacyReadModelRetraction,
): Promise<boolean> {
  const sourceTree = await loadAndLockSourceTree(
    tx,
    entry.userId,
    entry.sourceId,
  );
  if (sourceTree.length === 0) return false;
  const sourceIds = sourceTree.map((source) => source.id);
  const erasedAt = new Date();
  await eraseSourceReadModels(tx, entry.userId, sourceIds);
  await tx
    .update(sources)
    .set({
      metadata: {},
      contentType: null,
      contentLength: null,
      deletedAt: erasedAt,
    })
    .where(
      and(
        eq(sources.userId, entry.userId),
        inArray(sources.id, sourceIds),
        notExists(
          tx
            .select({ sourceId: sourceTombstones.sourceId })
            .from(sourceTombstones)
            .where(
              and(
                eq(sourceTombstones.userId, entry.userId),
                eq(sourceTombstones.sourceId, sources.id),
              ),
            ),
        ),
      ),
    );
  await tx
    .insert(sourceTombstones)
    .values(
      sourceTree.map((source) => ({
        userId: entry.userId,
        sourceId: source.id,
        partitionKey: source.partitionKey,
        state: "purged" as const,
        storageCleanupState: "pending" as const,
        storageObjectKey: sourceBlobObjectKey(entry.userId, source.id),
        readModelCleanupState: "completed" as const,
        erasedAt,
        finalizedAt: erasedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [sourceTombstones.userId, sourceTombstones.sourceId],
      set: { readModelCleanupState: "completed", updatedAt: erasedAt },
    });
  return true;
}

/**
 * Retracts read-model artifacts left by pre-lifecycle soft deletes. The
 * operation is maintenance-only, bounded, and concurrency-safe; each row is
 * terminally receipted only after its transaction has removed every derived
 * projection. Re-running it is therefore a no-op once completed.
 */
export async function retryPendingLegacySourceReadModelRetraction(
  db: DrizzleDB,
  limit: number,
): Promise<SourceLifecycleReadModelRetractionSweepResponse> {
  let attempted = 0;
  let completed = 0;
  for (let index = 0; index < limit; index += 1) {
    const result = await db.transaction(async (tx) => {
      const entry = await claimPendingLegacyReadModelRetraction(tx);
      if (!entry) return false;
      attempted += 1;
      return retractLegacySourceReadModels(tx, entry);
    });
    if (!result) break;
    completed += 1;
  }
  return { attempted, completed };
}

/**
 * Records physical deletion for an already-erased source. Unacknowledged
 * uploads belong to the sweep, including the gap between observation and delete.
 */
export async function markSourceStorageCleanupCompleted(
  db: DrizzleDB,
  userId: string,
  sourceId: SourceLifecycleCommandRequest["sourceId"],
): Promise<void> {
  await db
    .update(sourceTombstones)
    .set({ storageCleanupState: "completed", updatedAt: new Date() })
    .where(
      and(
        eq(sourceTombstones.userId, userId),
        eq(sourceTombstones.sourceId, sourceId),
        eq(sourceTombstones.storageCleanupState, "pending"),
        sql`NOT EXISTS (SELECT 1 FROM ${sourceBlobUploads} upload WHERE upload.user_id = ${sourceTombstones.userId} AND upload.source_id = ${sourceTombstones.sourceId} AND upload.uploaded_at IS NULL AND upload.state <> 'cleanup_completed')`,
      ),
    );
}

type PendingSourceTombstoneStorageCleanup = {
  userId: string;
  sourceId: TypeId<"source">;
  storageObjectKey: string;
  uploadUnknown: boolean;
};

/**
 * Lists durable physical-object cleanup work without consulting source rows or
 * command receipts. This is intentionally the recovery authority after a
 * restore/purge has removed the original source tree.
 */
async function listPendingSourceTombstoneStorageCleanup(
  db: DrizzleDB,
  limit: number,
): Promise<PendingSourceTombstoneStorageCleanup[]> {
  const rows = await db.execute<{
    user_id: string;
    source_id: string;
    storage_object_key: string;
    upload_unknown: boolean;
  }>(sql`
    SELECT pending.user_id, pending.source_id, pending.storage_object_key, bool_or(pending.upload_unknown) AS upload_unknown
    FROM (
      SELECT
        tombstone.user_id,
        tombstone.source_id,
        COALESCE(
          tombstone.storage_object_key,
          tombstone.user_id || '/' || tombstone.source_id
        ) AS storage_object_key,
        tombstone.updated_at AS retry_at,
        false AS upload_unknown
      FROM ${sourceTombstones} AS tombstone
      WHERE tombstone.storage_cleanup_state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM ${sourceBlobUploads} upload WHERE upload.user_id = tombstone.user_id AND upload.source_id = tombstone.source_id AND upload.state = 'upload_unknown')
      UNION ALL
      SELECT upload.user_id, upload.source_id, upload.object_key AS storage_object_key, upload.updated_at AS retry_at, upload.state = 'upload_unknown' AS upload_unknown
      FROM ${sourceBlobUploads} AS upload
      WHERE upload.state IN ('cleanup_pending', 'upload_unknown')
    ) AS pending
    GROUP BY pending.user_id, pending.source_id, pending.storage_object_key
    ORDER BY min(pending.retry_at), pending.user_id, pending.source_id
    LIMIT ${limit}
  `);
  return rows.rows.map((row) => ({
    userId: row.user_id,
    sourceId: typeIdFromString("source", row.source_id),
    storageObjectKey: row.storage_object_key,
    uploadUnknown: row.upload_unknown,
  }));
}

async function completePendingSourceTombstoneStorageCleanup(
  db: DrizzleDB,
  entry: PendingSourceTombstoneStorageCleanup,
  deleteObjectKey: (objectKey: string) => Promise<void>,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [tombstone] = await tx
      .select({ storageCleanupState: sourceTombstones.storageCleanupState })
      .from(sourceTombstones)
      .where(
        and(
          eq(sourceTombstones.userId, entry.userId),
          eq(sourceTombstones.sourceId, entry.sourceId),
        ),
      )
      .for("update")
      .limit(1);
    const [upload] = await tx
      .select({ state: sourceBlobUploads.state })
      .from(sourceBlobUploads)
      .where(
        and(
          eq(sourceBlobUploads.userId, entry.userId),
          eq(sourceBlobUploads.sourceId, entry.sourceId),
        ),
      )
      .for("update")
      .limit(1);
    // A tombstone must never advance while an upload reservation still owns
    // an external put. The lifecycle transition normally changes it first;
    // this branch is the durable recovery fence for interrupted deployments.
    if (
      upload &&
      upload.state !== "cleanup_pending" &&
      upload.state !== "cleanup_completed"
    ) {
      return false;
    }
    if (
      upload?.state !== "cleanup_pending" &&
      tombstone?.storageCleanupState !== "pending"
    ) {
      return false;
    }
    // A failed upload can restart at the same key. Hold its reservation lock
    // through deletion so a stale cleanup snapshot cannot erase retry bytes.
    await deleteObjectKey(entry.storageObjectKey);
    let completed = false;
    if (upload?.state === "cleanup_pending") {
      const updated = await tx
        .update(sourceBlobUploads)
        .set({
          state: "cleanup_completed",
          cleanupCompletedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceBlobUploads.userId, entry.userId),
            eq(sourceBlobUploads.sourceId, entry.sourceId),
            eq(sourceBlobUploads.state, "cleanup_pending"),
          ),
        )
        .returning({ sourceId: sourceBlobUploads.sourceId });
      completed ||= updated.length === 1;
    }
    if (tombstone?.storageCleanupState === "pending") {
      const updated = await tx
        .update(sourceTombstones)
        .set({ storageCleanupState: "completed", updatedAt: new Date() })
        .where(
          and(
            eq(sourceTombstones.userId, entry.userId),
            eq(sourceTombstones.sourceId, entry.sourceId),
            eq(sourceTombstones.storageCleanupState, "pending"),
          ),
        )
        .returning({ sourceId: sourceTombstones.sourceId });
      completed ||= updated.length === 1;
    }
    return completed;
  });
}

/**
 * Retries every selected physical deletion from the tombstone ledger. Object
 * deletion is idempotent; a tombstone receipt advances only after its own
 * opaque key has been removed successfully.
 */
export async function retryPendingSourceTombstoneStorageCleanup(
  db: DrizzleDB,
  deleteObjectKey: (objectKey: string) => Promise<void>,
  limit: number,
  _objectKeyExists?: (objectKey: string) => Promise<boolean>,
): Promise<SourceLifecycleStorageCleanupSweepResponse> {
  // Preserve the caller signature without using existence as settlement proof.
  void _objectKeyExists;
  await recoverAbandonedSourceBlobUploadReservations(db);
  await recoverTombstonedSourceBlobUploadReservations(db);
  const pending = await listPendingSourceTombstoneStorageCleanup(db, limit);
  const results = await Promise.all(
    pending.map(async (entry) => {
      try {
        if (entry.uploadUnknown) {
          // Rotate unresolved work to the back of the bounded queue. Absence
          // is not proof of cancellation: the single PUT can still arrive.
          await db
            .update(sourceBlobUploads)
            .set({ updatedAt: new Date() })
            .where(
              and(
                eq(sourceBlobUploads.userId, entry.userId),
                eq(sourceBlobUploads.sourceId, entry.sourceId),
                eq(sourceBlobUploads.state, "upload_unknown"),
              ),
            );
          // The key can contain an earlier attempt's bytes. Neither HEAD nor
          // deletion proves this timed-out PUT has settled; a delayed PUT
          // could overwrite the next retry. Keep its durable fence in place.
          return { completed: false };
        }
        return {
          completed: await completePendingSourceTombstoneStorageCleanup(
            db,
            entry,
            deleteObjectKey,
          ),
        };
      } catch (error: unknown) {
        return { error };
      }
    }),
  );
  await completeSourceLifecycleCommandsWithCompletedStorage(db);
  const failure = results.find(
    (result): result is { error: unknown } => "error" in result,
  );
  if (failure) throw failure.error;
  return {
    attempted: pending.length,
    completed: results
      .filter(
        (result): result is { completed: boolean } => "completed" in result,
      )
      .filter((result) => result.completed).length,
  };
}

/**
 * Converts uploads abandoned by a dead worker into ordinary cleanup work.
 * PostgreSQL rechecks the predicate after waiting on an active uploader's row
 * lock, so a put that completes while this sweep waits is not reclaimed.
 */
async function recoverAbandonedSourceBlobUploadReservations(
  db: DrizzleDB,
): Promise<void> {
  await db.execute(sql`
    WITH abandoned AS (
      UPDATE ${sourceBlobUploads} AS upload
      SET state = 'cleanup_pending', updated_at = now()
      WHERE upload.state IN ('reserved', 'uploading')
        AND upload.updated_at < now() - interval '1 hour'
        AND NOT EXISTS (
          SELECT 1
          FROM ${sourceTombstones} AS tombstone
          WHERE tombstone.user_id = upload.user_id
            AND tombstone.source_id = upload.source_id
        )
      RETURNING upload.user_id, upload.source_id
    )
    UPDATE ${sources} AS source
    SET status = 'failed'
    FROM abandoned
    WHERE source.user_id = abandoned.user_id
      AND source.id = abandoned.source_id
      AND source.deleted_at IS NULL
  `);
}

/**
 * Repairs any legacy/interrupted tombstone that predates its reservation
 * transition. A currently active uploader holds the same source row lock as
 * tombstone, so by the time its tombstone is durable this update cannot race a
 * put; a later uploader observes cleanup_pending before calling MinIO.
 */
async function recoverTombstonedSourceBlobUploadReservations(
  db: DrizzleDB,
): Promise<void> {
  await db.execute(sql`
    UPDATE ${sourceBlobUploads} AS upload
    SET state = 'cleanup_pending', updated_at = now()
    FROM ${sourceTombstones} AS tombstone
    WHERE upload.user_id = tombstone.user_id
      AND upload.source_id = tombstone.source_id
      AND tombstone.storage_cleanup_state = 'pending'
      AND upload.state IN ('reserved', 'uploading', 'uploaded')
  `);
}

/** Returns the durable root-operation cleanup snapshot, even after purge. */
export async function listSourceLifecycleStorageCleanupKeys(
  db: DrizzleDB,
  userId: string,
  commandId: string,
): Promise<string[]> {
  const [command] = await db
    .select({
      storageCleanupState: sourceLifecycleCommands.storageCleanupState,
      storageObjectKeys: sourceLifecycleCommands.storageObjectKeys,
    })
    .from(sourceLifecycleCommands)
    .where(
      and(
        eq(sourceLifecycleCommands.userId, userId),
        eq(sourceLifecycleCommands.commandId, commandId),
      ),
    )
    .limit(1);
  if (
    !command ||
    command.storageCleanupState !== "pending" ||
    command.storageObjectKeys.length === 0
  )
    return [];
  const unknown = await db
    .select({ objectKey: sourceBlobUploads.objectKey })
    .from(sourceBlobUploads)
    .where(
      and(
        eq(sourceBlobUploads.userId, userId),
        eq(sourceBlobUploads.state, "upload_unknown"),
        inArray(sourceBlobUploads.objectKey, command.storageObjectKeys),
      ),
    );
  const unknownKeys = new Set(unknown.map((upload) => upload.objectKey));
  return command.storageObjectKeys.filter((key) => !unknownKeys.has(key));
}

/** Lists every pending blob in a root source tree without exposing content. */
export async function listSourceTreeStorageCleanupIds(
  db: DrizzleDB,
  userId: string,
  sourceId: SourceLifecycleCommandRequest["sourceId"],
): Promise<TypeId<"source">[]> {
  const result = await db.execute<{ source_id: string }>(sql`
    WITH RECURSIVE source_tree(source_id) AS (
      SELECT id FROM ${sources}
      WHERE user_id = ${userId} AND id = ${sourceId}
      UNION
      SELECT child.id FROM ${sources} child
      JOIN source_tree parent ON child.parent_source = parent.source_id
      WHERE child.user_id = ${userId}
    )
    SELECT tombstone.source_id
    FROM ${sourceTombstones} tombstone
    JOIN source_tree ON source_tree.source_id = tombstone.source_id
    WHERE tombstone.user_id = ${userId}
      AND tombstone.storage_cleanup_state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM ${sourceBlobUploads} upload WHERE upload.user_id = tombstone.user_id AND upload.source_id = tombstone.source_id AND upload.state = 'upload_unknown')
    ORDER BY tombstone.source_id
  `);
  return result.rows.map((row) => typeIdFromString("source", row.source_id));
}

/**
 * Records direct tree cleanup. An upload without an acknowledgement remains
 * sweep-owned until its own physical deletion has completed.
 */
export async function markSourceTreeStorageCleanupCompleted(
  db: DrizzleDB,
  userId: string,
  sourceId: SourceLifecycleCommandRequest["sourceId"],
): Promise<void> {
  const sourceIds = await listSourceTreeStorageCleanupIds(db, userId, sourceId);
  if (sourceIds.length > 0) {
    await db
      .update(sourceTombstones)
      .set({ storageCleanupState: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(sourceTombstones.userId, userId),
          inArray(sourceTombstones.sourceId, sourceIds),
          sql`NOT EXISTS (SELECT 1 FROM ${sourceBlobUploads} upload WHERE upload.user_id = ${sourceTombstones.userId} AND upload.source_id = ${sourceTombstones.sourceId} AND upload.uploaded_at IS NULL AND upload.state <> 'cleanup_completed')`,
        ),
      );
  }
  // Restore/purge may have removed the source tree already. The durable root
  // receipt still identifies exactly which tombstones own the deleted keys.
  await db.execute(sql`
    UPDATE ${sourceTombstones}
    SET storage_cleanup_state = 'completed', updated_at = now()
    WHERE user_id = ${userId}
      AND storage_cleanup_state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM ${sourceBlobUploads} upload WHERE upload.user_id = ${sourceTombstones}.user_id AND upload.source_id = ${sourceTombstones}.source_id AND upload.uploaded_at IS NULL AND upload.state <> 'cleanup_completed')
      AND storage_object_key IN (
        SELECT unnest(storage_object_keys)
        FROM ${sourceLifecycleCommands}
        WHERE user_id = ${userId}
          AND source_id = ${sourceId}
          AND storage_cleanup_state = 'pending'
      )
  `);
  await completeSourceLifecycleCommandsWithCompletedStorage(db, userId);
}

/**
 * Advances every pending command whose full immutable cleanup snapshot is now
 * covered by completed tombstones. A parent-tree cleanup can satisfy a child
 * command too, so convergence cannot be scoped to the root command alone.
 */
async function completeSourceLifecycleCommandsWithCompletedStorage(
  db: DrizzleDB,
  userId?: string,
): Promise<void> {
  const userClause =
    userId === undefined ? sql`` : sql`AND command.user_id = ${userId}`;
  await db.execute(sql`
    UPDATE ${sourceLifecycleCommands} AS command
    SET storage_cleanup_state = 'completed'
    WHERE command.storage_cleanup_state = 'pending'
      ${userClause}
      AND cardinality(command.storage_object_keys) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM unnest(command.storage_object_keys) AS cleanup_key(object_key)
        WHERE NOT EXISTS (
          SELECT 1
          FROM ${sourceTombstones} AS tombstone
          WHERE tombstone.user_id = command.user_id
            AND COALESCE(
              tombstone.storage_object_key,
              tombstone.user_id || '/' || tombstone.source_id
            ) = cleanup_key.object_key
            AND tombstone.storage_cleanup_state = 'completed'
        )
      )
  `);
}

async function storageCleanupObjectKeys(
  tx: Transaction,
  request: SourceLifecycleCommandRequest,
  sourceTree: LockedSource[],
): Promise<string[]> {
  if (request.action === "tombstone") {
    return sourceTree.map((source) =>
      sourceBlobObjectKey(request.userId, source.id),
    );
  }
  const rows = await tx
    .select({ storageObjectKey: sourceTombstones.storageObjectKey })
    .from(sourceTombstones)
    .where(
      and(
        eq(sourceTombstones.userId, request.userId),
        inArray(
          sourceTombstones.sourceId,
          sourceTree.map((source) => source.id),
        ),
      ),
    );
  return rows.flatMap((row) =>
    row.storageObjectKey ? [row.storageObjectKey] : [],
  );
}
