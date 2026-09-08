/** Durable, provenance-conserving recovery for derivative node artifacts. */
import { and, eq, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  commitmentPresentations,
  nodeEmbeddings,
  nodeMetadata,
  nodeRedirects,
  nodes,
  partitionArtifactReceipts,
  partitionNodeMappings,
  sourceTombstones,
  sources,
  userProfiles,
} from "~/db/schema";
import { PartitionReclassificationError } from "~/lib/partition-errors";
import {
  partitionNodeMappingSchema,
  type ContextPartitionKey,
  type PartitionNodeMapping,
} from "~/lib/schemas/partition";
import type { NodeType } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

type Transaction = Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];

interface RecoverPartitionNodeInput {
  tx: Transaction;
  userId: string;
  sourceId: TypeId<"source">;
  sourceNodeId: TypeId<"node">;
  nodeType: NodeType;
  partitionKey: ContextPartitionKey;
  bindingGeneration: string;
}

export interface ResumePartitionNodeRecoveryInput {
  userId: string;
  sourceNodeId: TypeId<"node">;
  partitionKey: ContextPartitionKey;
}

/** Resumes a durable quarantined reservation after process interruption. */
export async function resumePartitionNodeRecovery(
  db: DrizzleDB,
  request: ResumePartitionNodeRecoveryInput,
): Promise<PartitionNodeMapping> {
  return db.transaction(async (tx) => {
    const [mapping] = await tx
      .select()
      .from(partitionNodeMappings)
      .where(
        and(
          eq(partitionNodeMappings.userId, request.userId),
          eq(partitionNodeMappings.sourceNodeId, request.sourceNodeId),
          eq(partitionNodeMappings.partitionKey, request.partitionKey),
        ),
      )
      .for("update")
      .limit(1);
    if (!mapping) {
      throw new Error(
        `No partition recovery exists for node ${request.sourceNodeId}`,
      );
    }
    const [source, tombstone] = await Promise.all([
      tx
        .select({ deletedAt: sources.deletedAt })
        .from(sources)
        .where(
          and(
            eq(sources.userId, request.userId),
            eq(sources.id, mapping.sourceId),
          ),
        )
        .limit(1),
      tx
        .select({ sourceId: sourceTombstones.sourceId })
        .from(sourceTombstones)
        .where(
          and(
            eq(sourceTombstones.userId, request.userId),
            eq(sourceTombstones.sourceId, mapping.sourceId),
          ),
        )
        .limit(1),
    ]);
    if (source[0]?.deletedAt !== null || tombstone[0]) {
      throw new Error(
        `Cannot resume recovery for a tombstoned source ${mapping.sourceId}`,
      );
    }
    const replacementPartitionMatches =
      mapping.replacementNodeId &&
      (await replacementMatchesPartition(
        tx,
        request.userId,
        mapping.replacementNodeId,
        request.partitionKey,
      ));
    if (mapping.state === "completed" && mapping.replacementNodeId) {
      if (replacementPartitionMatches) {
        return partitionNodeMappingSchema.parse({
          sourceNodeId: request.sourceNodeId,
          partitionKey: request.partitionKey,
          replacementNodeId: mapping.replacementNodeId,
        });
      }
    }
    const [node] = await tx
      .select({ nodeType: nodes.nodeType })
      .from(nodes)
      .where(
        and(
          eq(nodes.userId, request.userId),
          eq(nodes.id, request.sourceNodeId),
        ),
      )
      .limit(1);
    if (!node) {
      throw new Error(
        `Cannot resume recovery after source node ${request.sourceNodeId} was deleted`,
      );
    }
    const input: RecoverPartitionNodeInput = {
      tx,
      userId: request.userId,
      sourceId: mapping.sourceId,
      sourceNodeId: request.sourceNodeId,
      nodeType: node.nodeType,
      partitionKey: request.partitionKey,
      bindingGeneration: mapping.bindingGeneration,
    };
    if (mapping.state === "completed" && mapping.replacementNodeId) {
      await reopenPartitionNodeMapping(input, mapping.replacementNodeId);
      return rebuildReservedPartitionNode(input, null);
    }
    if (mapping.replacementNodeId && !replacementPartitionMatches) {
      await reopenPartitionNodeMapping(input, mapping.replacementNodeId);
      return rebuildReservedPartitionNode(input, null);
    }
    return rebuildReservedPartitionNode(input, mapping.replacementNodeId);
  });
}

/** Returns a completed prior split, or fails closed on incomplete recovery. */
export async function reusePartitionNodeMapping(
  input: RecoverPartitionNodeInput,
): Promise<PartitionNodeMapping | null> {
  const existing = await loadMappingForUpdate(input);
  if (!existing) return null;
  if (existing.state === "completed" && existing.replacementNodeId) {
    const [replacement] = await input.tx
      .select({ partitionKey: nodes.partitionKey })
      .from(nodes)
      .where(
        and(
          eq(nodes.userId, input.userId),
          eq(nodes.id, existing.replacementNodeId),
        ),
      )
      .limit(1);
    if (replacement?.partitionKey !== input.partitionKey) {
      await reopenPartitionNodeMapping(input, existing.replacementNodeId);
      return rebuildReservedPartitionNode(input, null);
    }
    await refreshSourceOwnedPresentation(input, existing.replacementNodeId);
    return partitionNodeMappingSchema.parse({
      sourceNodeId: input.sourceNodeId,
      partitionKey: input.partitionKey,
      replacementNodeId: existing.replacementNodeId,
    });
  }
  if (existing.state === "quarantined" && existing.replacementNodeId === null) {
    const pendingReceipt = await input.tx.$count(
      partitionArtifactReceipts,
      and(
        eq(partitionArtifactReceipts.userId, input.userId),
        eq(partitionArtifactReceipts.sourceNodeId, input.sourceNodeId),
        eq(partitionArtifactReceipts.partitionKey, input.partitionKey),
        eq(partitionArtifactReceipts.disposition, "pending"),
      ),
    );
    if (pendingReceipt > 0) {
      return rebuildReservedPartitionNode(input, null);
    }
  }
  throw quarantinedMappingError(input);
}

/** Reserves or reuses one old-node/target mapping without producing orphans. */
export async function recoverPartitionNode(
  input: RecoverPartitionNodeInput,
): Promise<PartitionNodeMapping> {
  const reused = await reusePartitionNodeMapping(input);
  if (reused) return reused;
  const existing = await loadMappingForUpdate(input);
  if (existing) {
    const pendingReceipt = await input.tx.$count(
      partitionArtifactReceipts,
      and(
        eq(partitionArtifactReceipts.userId, input.userId),
        eq(partitionArtifactReceipts.sourceNodeId, input.sourceNodeId),
        eq(partitionArtifactReceipts.partitionKey, input.partitionKey),
        eq(partitionArtifactReceipts.disposition, "pending"),
      ),
    );
    if (existing.state === "quarantined" && pendingReceipt > 0) {
      return rebuildReservedPartitionNode(input, existing.replacementNodeId);
    }
    throw quarantinedMappingError(input);
  }

  const [reserved] = await input.tx
    .insert(partitionNodeMappings)
    .values({
      userId: input.userId,
      sourceNodeId: input.sourceNodeId,
      partitionKey: input.partitionKey,
      replacementNodeId: null,
      sourceId: input.sourceId,
      bindingGeneration: input.bindingGeneration,
      state: "quarantined",
    })
    .onConflictDoNothing({
      target: [
        partitionNodeMappings.userId,
        partitionNodeMappings.sourceNodeId,
        partitionNodeMappings.partitionKey,
      ],
    })
    .returning({ sourceNodeId: partitionNodeMappings.sourceNodeId });
  if (!reserved) {
    const concurrent = await loadMappingForUpdate(input);
    if (concurrent?.state === "completed" && concurrent.replacementNodeId) {
      if (
        !(await replacementMatchesPartition(
          input.tx,
          input.userId,
          concurrent.replacementNodeId,
          input.partitionKey,
        ))
      ) {
        throw quarantinedMappingError(input);
      }
      return partitionNodeMappingSchema.parse({
        sourceNodeId: input.sourceNodeId,
        partitionKey: input.partitionKey,
        replacementNodeId: concurrent.replacementNodeId,
      });
    }
    throw quarantinedMappingError(input);
  }

  return rebuildReservedPartitionNode(input, null);
}

async function loadMappingForUpdate(input: RecoverPartitionNodeInput) {
  const [mapping] = await input.tx
    .select({
      state: partitionNodeMappings.state,
      replacementNodeId: partitionNodeMappings.replacementNodeId,
      sourceId: partitionNodeMappings.sourceId,
      bindingGeneration: partitionNodeMappings.bindingGeneration,
    })
    .from(partitionNodeMappings)
    .where(
      and(
        eq(partitionNodeMappings.userId, input.userId),
        eq(partitionNodeMappings.sourceNodeId, input.sourceNodeId),
        eq(partitionNodeMappings.partitionKey, input.partitionKey),
      ),
    )
    .for("update")
    .limit(1);
  return mapping;
}

async function replacementMatchesPartition(
  tx: Transaction,
  userId: string,
  replacementNodeId: TypeId<"node">,
  partitionKey: ContextPartitionKey,
): Promise<boolean> {
  const [replacement] = await tx
    .select({ partitionKey: nodes.partitionKey })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), eq(nodes.id, replacementNodeId)))
    .limit(1);
  return replacement?.partitionKey === partitionKey;
}

async function reopenPartitionNodeMapping(
  input: RecoverPartitionNodeInput,
  replacementNodeId: TypeId<"node">,
): Promise<void> {
  await input.tx
    .update(partitionNodeMappings)
    .set({
      replacementNodeId: null,
      state: "quarantined",
      sourceId: input.sourceId,
      bindingGeneration: input.bindingGeneration,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(partitionNodeMappings.userId, input.userId),
        eq(partitionNodeMappings.sourceNodeId, input.sourceNodeId),
        eq(partitionNodeMappings.partitionKey, input.partitionKey),
        eq(partitionNodeMappings.replacementNodeId, replacementNodeId),
      ),
    );
  await input.tx
    .update(partitionArtifactReceipts)
    .set({
      disposition: "pending",
      details: { reason: "replacement moved out of target partition" },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(partitionArtifactReceipts.userId, input.userId),
        eq(partitionArtifactReceipts.sourceNodeId, input.sourceNodeId),
        eq(partitionArtifactReceipts.partitionKey, input.partitionKey),
      ),
    );
}

function quarantinedMappingError(
  input: RecoverPartitionNodeInput,
): PartitionReclassificationError {
  return new PartitionReclassificationError(
    "MAPPING_QUARANTINED",
    `Node ${input.sourceNodeId} has an incomplete recovery for partition ${input.partitionKey}`,
    {
      sourceNodeId: input.sourceNodeId,
      targetPartitionKey: input.partitionKey,
    },
  );
}

/** Refreshes source-owned presentation evidence when a completed split is reused. */
async function refreshSourceOwnedPresentation(
  input: RecoverPartitionNodeInput,
  replacementNodeId: TypeId<"node">,
): Promise<void> {
  const [sourcePresentation] = await input.tx
    .select({
      userId: commitmentPresentations.userId,
      sourceId: commitmentPresentations.sourceId,
      excerpt: commitmentPresentations.excerpt,
      why: commitmentPresentations.why,
    })
    .from(commitmentPresentations)
    .where(
      and(
        eq(commitmentPresentations.taskId, input.sourceNodeId),
        eq(commitmentPresentations.sourceId, input.sourceId),
      ),
    )
    .limit(1);
  if (!sourcePresentation) return;

  const [existingPresentation] = await input.tx
    .select({
      userId: commitmentPresentations.userId,
      sourceId: commitmentPresentations.sourceId,
      excerpt: commitmentPresentations.excerpt,
      why: commitmentPresentations.why,
    })
    .from(commitmentPresentations)
    .where(eq(commitmentPresentations.taskId, replacementNodeId))
    .limit(1);
  const [receipt] = await input.tx
    .select({
      sourceCount: partitionArtifactReceipts.sourceCount,
      rebuiltCount: partitionArtifactReceipts.rebuiltCount,
      quarantinedCount: partitionArtifactReceipts.quarantinedCount,
    })
    .from(partitionArtifactReceipts)
    .where(
      and(
        eq(partitionArtifactReceipts.userId, input.userId),
        eq(partitionArtifactReceipts.sourceNodeId, input.sourceNodeId),
        eq(partitionArtifactReceipts.partitionKey, input.partitionKey),
        eq(partitionArtifactReceipts.artifactKind, "commitment_presentation"),
      ),
    )
    .limit(1);
  if (!receipt) return;

  if (
    existingPresentation?.userId === sourcePresentation.userId &&
    existingPresentation?.sourceId === input.sourceId &&
    existingPresentation.excerpt === sourcePresentation.excerpt &&
    existingPresentation.why === sourcePresentation.why
  ) {
    return;
  }
  await input.tx
    .update(partitionNodeMappings)
    .set({ state: "quarantined", updatedAt: new Date() })
    .where(
      and(
        eq(partitionNodeMappings.userId, input.userId),
        eq(partitionNodeMappings.sourceNodeId, input.sourceNodeId),
        eq(partitionNodeMappings.partitionKey, input.partitionKey),
        eq(partitionNodeMappings.state, "completed"),
      ),
    );

  const nextSourceCount = receipt.sourceCount + 1;
  if (
    existingPresentation &&
    (existingPresentation.userId !== sourcePresentation.userId ||
      existingPresentation.sourceId !== input.sourceId)
  ) {
    await input.tx
      .delete(commitmentPresentations)
      .where(eq(commitmentPresentations.taskId, replacementNodeId));
    await updatePresentationReceipt(input, {
      sourceCount: nextSourceCount,
      rebuiltCount: 0,
      quarantinedCount: nextSourceCount,
      disposition: "quarantined",
      details: {
        reason: "multiple source-owned presentations cannot share one task row",
        sourceIds: [existingPresentation.sourceId, input.sourceId],
        userIds: [existingPresentation.userId, sourcePresentation.userId],
      },
    });
    await completeRefreshedMapping(input);
    return;
  }

  if (
    existingPresentation?.userId === sourcePresentation.userId &&
    existingPresentation.sourceId === input.sourceId
  ) {
    await input.tx
      .update(commitmentPresentations)
      .set({
        excerpt: sourcePresentation.excerpt,
        why: sourcePresentation.why,
      })
      .where(eq(commitmentPresentations.taskId, replacementNodeId));
    const quarantinedCount = receipt.quarantinedCount;
    await updatePresentationReceipt(input, {
      sourceCount: receipt.sourceCount,
      rebuiltCount: receipt.rebuiltCount,
      quarantinedCount,
      disposition: quarantinedCount > 0 ? "quarantined" : "rebuilt",
      details: { provenanceSourceId: input.sourceId, refreshed: true },
    });
    await completeRefreshedMapping(input);
    return;
  }

  if (!existingPresentation) {
    await input.tx
      .insert(commitmentPresentations)
      .values({ taskId: replacementNodeId, ...sourcePresentation })
      .onConflictDoNothing({ target: commitmentPresentations.taskId });
    const quarantinedCount = receipt.quarantinedCount;
    await updatePresentationReceipt(input, {
      sourceCount: nextSourceCount,
      rebuiltCount: receipt.rebuiltCount + 1,
      quarantinedCount,
      disposition: quarantinedCount > 0 ? "quarantined" : "rebuilt",
      details: { provenanceSourceId: input.sourceId },
    });
    await completeRefreshedMapping(input);
  }
}

async function completeRefreshedMapping(
  input: RecoverPartitionNodeInput,
): Promise<void> {
  await input.tx
    .update(partitionNodeMappings)
    .set({ state: "completed", updatedAt: new Date() })
    .where(
      and(
        eq(partitionNodeMappings.userId, input.userId),
        eq(partitionNodeMappings.sourceNodeId, input.sourceNodeId),
        eq(partitionNodeMappings.partitionKey, input.partitionKey),
      ),
    );
}

async function updatePresentationReceipt(
  input: RecoverPartitionNodeInput,
  values: {
    sourceCount: number;
    rebuiltCount: number;
    quarantinedCount: number;
    disposition: "rebuilt" | "quarantined";
    details: unknown;
  },
): Promise<void> {
  await input.tx
    .update(partitionArtifactReceipts)
    .set({ ...values, updatedAt: new Date() })
    .where(
      and(
        eq(partitionArtifactReceipts.userId, input.userId),
        eq(partitionArtifactReceipts.sourceNodeId, input.sourceNodeId),
        eq(partitionArtifactReceipts.partitionKey, input.partitionKey),
        eq(partitionArtifactReceipts.artifactKind, "commitment_presentation"),
      ),
    );
}

async function rebuildReservedPartitionNode(
  input: RecoverPartitionNodeInput,
  existingReplacementNodeId: TypeId<"node"> | null,
): Promise<PartitionNodeMapping> {
  const replacementNodeId =
    existingReplacementNodeId ??
    (
      await input.tx
        .insert(nodes)
        .values({
          userId: input.userId,
          nodeType: input.nodeType,
          partitionKey: input.partitionKey,
        })
        .returning({ id: nodes.id })
    )[0]?.id;
  if (!replacementNodeId)
    throw new Error(`Failed to split node ${input.sourceNodeId}`);

  await input.tx
    .update(partitionNodeMappings)
    .set({ replacementNodeId, updatedAt: new Date() })
    .where(
      and(
        eq(partitionNodeMappings.userId, input.userId),
        eq(partitionNodeMappings.sourceNodeId, input.sourceNodeId),
        eq(partitionNodeMappings.partitionKey, input.partitionKey),
      ),
    );

  const [metadata] = await input.tx
    .select({
      label: nodeMetadata.label,
      canonicalLabel: nodeMetadata.canonicalLabel,
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodeMetadata)
    .where(eq(nodeMetadata.nodeId, input.sourceNodeId))
    .limit(1);
  if (metadata) {
    await input.tx
      .insert(nodeMetadata)
      .values({
        nodeId: replacementNodeId,
        label: metadata.label,
        canonicalLabel: metadata.canonicalLabel,
        description: null,
        additionalData: null,
      })
      .onConflictDoNothing({ target: nodeMetadata.nodeId });
  }

  const [
    aliasCount,
    embeddingCount,
    redirectCount,
    profileCount,
    presentation,
  ] = await Promise.all([
    input.tx.$count(aliases, eq(aliases.canonicalNodeId, input.sourceNodeId)),
    input.tx.$count(
      nodeEmbeddings,
      eq(nodeEmbeddings.nodeId, input.sourceNodeId),
    ),
    input.tx.$count(
      nodeRedirects,
      and(
        eq(nodeRedirects.userId, input.userId),
        eq(nodeRedirects.toNodeId, input.sourceNodeId),
      ),
    ),
    input.tx.$count(userProfiles, eq(userProfiles.userId, input.userId)),
    input.tx
      .select({
        userId: commitmentPresentations.userId,
        sourceId: commitmentPresentations.sourceId,
        excerpt: commitmentPresentations.excerpt,
        why: commitmentPresentations.why,
      })
      .from(commitmentPresentations)
      .where(
        and(
          eq(commitmentPresentations.taskId, input.sourceNodeId),
          eq(commitmentPresentations.sourceId, input.sourceId),
        ),
      )
      .limit(1),
  ]);
  const sourcePresentation = presentation[0];
  if (sourcePresentation) {
    await input.tx
      .insert(commitmentPresentations)
      .values({ taskId: replacementNodeId, ...sourcePresentation })
      .onConflictDoNothing({ target: commitmentPresentations.taskId });
  }

  const summaryCount =
    metadata &&
    (metadata.description !== null || metadata.additionalData !== null)
      ? 1
      : 0;
  const receiptValues = [
    quarantineReceipt(input, "aliases", aliasCount),
    quarantineReceipt(input, "node_embeddings", embeddingCount),
    quarantineReceipt(input, "redirects", redirectCount),
    quarantineReceipt(input, "summary", summaryCount),
    quarantineReceipt(input, "user_profile", profileCount),
    {
      ...receiptIdentity(input),
      artifactKind: "commitment_presentation" as const,
      disposition: sourcePresentation
        ? ("rebuilt" as const)
        : ("not_applicable" as const),
      sourceCount: sourcePresentation ? 1 : 0,
      rebuiltCount: sourcePresentation ? 1 : 0,
      quarantinedCount: 0,
      details: { provenanceSourceId: input.sourceId },
    },
  ];
  await input.tx
    .insert(partitionArtifactReceipts)
    .values(receiptValues)
    .onConflictDoUpdate({
      target: [
        partitionArtifactReceipts.userId,
        partitionArtifactReceipts.sourceNodeId,
        partitionArtifactReceipts.partitionKey,
        partitionArtifactReceipts.artifactKind,
      ],
      set: {
        disposition: sql`excluded.disposition`,
        sourceCount: sql`excluded.source_count`,
        rebuiltCount: sql`excluded.rebuilt_count`,
        quarantinedCount: sql`excluded.quarantined_count`,
        details: sql`excluded.details`,
        updatedAt: new Date(),
      },
    });

  await input.tx
    .update(partitionNodeMappings)
    .set({ state: "completed", updatedAt: new Date() })
    .where(
      and(
        eq(partitionNodeMappings.userId, input.userId),
        eq(partitionNodeMappings.sourceNodeId, input.sourceNodeId),
        eq(partitionNodeMappings.partitionKey, input.partitionKey),
      ),
    );
  return partitionNodeMappingSchema.parse({
    sourceNodeId: input.sourceNodeId,
    partitionKey: input.partitionKey,
    replacementNodeId,
  });
}

function receiptIdentity(input: RecoverPartitionNodeInput) {
  return {
    userId: input.userId,
    sourceNodeId: input.sourceNodeId,
    partitionKey: input.partitionKey,
  };
}

function quarantineReceipt(
  input: RecoverPartitionNodeInput,
  artifactKind:
    | "aliases"
    | "node_embeddings"
    | "redirects"
    | "summary"
    | "user_profile",
  sourceCount: number,
) {
  return {
    ...receiptIdentity(input),
    artifactKind,
    disposition:
      sourceCount > 0 ? ("quarantined" as const) : ("not_applicable" as const),
    sourceCount,
    rebuiltCount: 0,
    quarantinedCount: sourceCount,
    details: { reason: "artifact provenance cannot be safely partitioned" },
  };
}
