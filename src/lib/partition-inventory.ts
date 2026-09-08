/** Authenticated operational inventory for partition migration and recovery. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  partitionArtifactReceipts,
  partitionMigrationState,
  partitionNodeMappings,
  sources,
} from "~/db/schema";
import type {
  PartitionInventoryRequest,
  PartitionInventoryResponse,
  PartitionProgressRequest,
  PartitionProgressResponse,
} from "~/lib/schemas/partition";

export async function getPartitionProgress(
  db: DrizzleDB,
  request: PartitionProgressRequest,
): Promise<PartitionProgressResponse> {
  const [migration, source] = await Promise.all([
    db
      .select({
        state: partitionMigrationState.state,
        version: partitionMigrationState.version,
      })
      .from(partitionMigrationState)
      .where(eq(partitionMigrationState.userId, request.userId))
      .limit(1),
    request.sourceId === undefined
      ? Promise.resolve([])
      : db
          .select({
            sourceId: sources.id,
            partitionKey: sources.partitionKey,
            version: sources.version,
          })
          .from(sources)
          .where(
            and(
              eq(sources.userId, request.userId),
              eq(sources.id, request.sourceId),
            ),
          )
          .limit(1),
  ]);
  return {
    migration: migration[0] ?? { state: "unmigrated", version: 0 },
    source: source[0] ?? null,
  };
}

export async function getPartitionInventory(
  db: DrizzleDB,
  request: PartitionInventoryRequest,
): Promise<PartitionInventoryResponse> {
  const limit = request.limit ?? 50;
  const cursorExpression = sql<string>`${partitionNodeMappings.sourceNodeId} || E'\\x1f' || ${partitionNodeMappings.partitionKey}`;
  const rows = await db
    .select({
      sourceNodeId: partitionNodeMappings.sourceNodeId,
      partitionKey: partitionNodeMappings.partitionKey,
      replacementNodeId: partitionNodeMappings.replacementNodeId,
      sourceId: partitionNodeMappings.sourceId,
      bindingGeneration: partitionNodeMappings.bindingGeneration,
      state: partitionNodeMappings.state,
    })
    .from(partitionNodeMappings)
    .where(
      and(
        eq(partitionNodeMappings.userId, request.userId),
        request.cursor === undefined
          ? undefined
          : sql`${cursorExpression} > ${request.cursor}`,
      ),
    )
    .orderBy(
      asc(partitionNodeMappings.sourceNodeId),
      asc(partitionNodeMappings.partitionKey),
    )
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const sourceNodeIds = page.map((row) => row.sourceNodeId);
  const receipts =
    sourceNodeIds.length === 0
      ? []
      : await db
          .select({
            sourceNodeId: partitionArtifactReceipts.sourceNodeId,
            partitionKey: partitionArtifactReceipts.partitionKey,
            kind: partitionArtifactReceipts.artifactKind,
            disposition: partitionArtifactReceipts.disposition,
            sourceCount: partitionArtifactReceipts.sourceCount,
            rebuiltCount: partitionArtifactReceipts.rebuiltCount,
            quarantinedCount: partitionArtifactReceipts.quarantinedCount,
          })
          .from(partitionArtifactReceipts)
          .where(
            and(
              eq(partitionArtifactReceipts.userId, request.userId),
              inArray(partitionArtifactReceipts.sourceNodeId, sourceNodeIds),
            ),
          );
  const cursorFor = (sourceNodeId: string, partitionKey: string): string =>
    `${sourceNodeId}\u001f${partitionKey}`;
  const items = page.map((row) => ({
    ...row,
    artifacts: receipts
      .filter(
        (receipt) =>
          receipt.sourceNodeId === row.sourceNodeId &&
          receipt.partitionKey === row.partitionKey,
      )
      .map((receipt) => ({
        kind: receipt.kind,
        disposition: receipt.disposition,
        sourceCount: receipt.sourceCount,
        rebuiltCount: receipt.rebuiltCount,
        quarantinedCount: receipt.quarantinedCount,
      })),
  }));
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? cursorFor(last.sourceNodeId, last.partitionKey)
        : null,
  };
}
