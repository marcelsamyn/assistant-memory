/** Compare-and-set lifecycle for enabling partition enforcement per user. */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  memoryPartitions,
  nodeRedirects,
  nodes,
  partitionMigrationState,
  rollupState,
  sourceLinks,
  sources,
} from "~/db/schema";
import { PartitionReclassificationError } from "~/lib/partition-errors";
import type {
  PartitionMigrationState,
  SetPartitionMigrationStateRequest,
  SetPartitionMigrationStateResponse,
} from "~/lib/schemas/partition";

type Transaction = Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];

async function loadMigrationState(
  tx: Transaction,
  userId: string,
): Promise<{ state: PartitionMigrationState; version: number }> {
  const [row] = await tx
    .select({
      state: partitionMigrationState.state,
      version: partitionMigrationState.version,
    })
    .from(partitionMigrationState)
    .where(eq(partitionMigrationState.userId, userId))
    .limit(1);
  return row ?? { state: "unmigrated", version: 0 };
}

function migrationConflict(
  message: string,
  current: { state: PartitionMigrationState; version: number },
): PartitionReclassificationError {
  return new PartitionReclassificationError(
    "MIGRATION_STATE_CONFLICT",
    message,
    {
      migrationState: current.state,
      migrationVersion: current.version,
    },
  );
}

export async function setPartitionMigrationState(
  db: DrizzleDB,
  request: SetPartitionMigrationStateRequest,
): Promise<SetPartitionMigrationStateResponse> {
  return db.transaction(async (tx) => {
    const current = await loadMigrationState(tx, request.userId);
    if (
      current.state !== request.expectedState ||
      current.version !== request.expectedVersion
    ) {
      throw migrationConflict(
        `Partition migration state changed: expected ${request.expectedState}@${request.expectedVersion}, found ${current.state}@${current.version}`,
        current,
      );
    }
    const transitionAllowed =
      (current.state === "unmigrated" && request.nextState === "migrating") ||
      (current.state === "migrating" && request.nextState === "migrated") ||
      (current.state === "migrating" && request.nextState === "migrating");
    if (!transitionAllowed) {
      throw migrationConflict(
        `Invalid partition migration transition ${current.state} -> ${request.nextState}`,
        current,
      );
    }

    if (request.nextState === "migrated") {
      await finishLegacyMigration(tx, request);
    }

    const nextVersion = current.version + 1;
    if (current.state === "unmigrated") {
      const [inserted] = await tx
        .insert(partitionMigrationState)
        .values({
          userId: request.userId,
          state: request.nextState,
          version: nextVersion,
        })
        .onConflictDoNothing({ target: partitionMigrationState.userId })
        .returning({ version: partitionMigrationState.version });
      if (!inserted) {
        throw migrationConflict(
          "Partition migration state changed concurrently",
          await loadMigrationState(tx, request.userId),
        );
      }
    } else {
      const [updated] = await tx
        .update(partitionMigrationState)
        .set({
          state: request.nextState,
          version: nextVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(partitionMigrationState.userId, request.userId),
            eq(partitionMigrationState.version, request.expectedVersion),
          ),
        )
        .returning({ version: partitionMigrationState.version });
      if (!updated) {
        throw migrationConflict(
          "Partition migration state changed concurrently",
          await loadMigrationState(tx, request.userId),
        );
      }
    }
    return { state: request.nextState, version: nextVersion };
  });
}

async function finishLegacyMigration(
  tx: Transaction,
  request: SetPartitionMigrationStateRequest,
): Promise<void> {
  const unassignedPartitionKey = request.unassignedPartitionKey;
  if (unassignedPartitionKey === undefined) {
    throw new PartitionReclassificationError(
      "MIGRATION_INCOMPLETE",
      "An unassigned partition is required to finish migration",
    );
  }
  await tx
    .insert(memoryPartitions)
    .values({
      userId: request.userId,
      partitionKey: unassignedPartitionKey,
      status: "active",
    })
    .onConflictDoNothing({
      target: [memoryPartitions.userId, memoryPartitions.partitionKey],
    });

  // Legacy rollups combine evidence from every source. They cannot be
  // partitioned without inventing provenance, so discard and rebuild them.
  await tx
    .delete(rollupState)
    .where(
      and(
        eq(rollupState.userId, request.userId),
        isNull(rollupState.partitionKey),
      ),
    );

  const orphanNodes = await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.userId, request.userId),
        isNull(nodes.partitionKey),
        sql`NOT EXISTS (SELECT 1 FROM ${sourceLinks} sl WHERE sl.node_id = ${nodes.id})`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${claims} c
          WHERE c.subject_node_id = ${nodes.id}
             OR c.object_node_id = ${nodes.id}
             OR c.asserted_by_node_id = ${nodes.id}
        )`,
      ),
    );
  const orphanNodeIds = orphanNodes.map((node) => node.id);
  if (orphanNodeIds.length > 0) {
    await Promise.all([
      tx
        .update(nodes)
        .set({ partitionKey: unassignedPartitionKey })
        .where(inArray(nodes.id, orphanNodeIds)),
      tx
        .update(aliases)
        .set({ partitionKey: unassignedPartitionKey })
        .where(inArray(aliases.canonicalNodeId, orphanNodeIds)),
      tx
        .update(nodeRedirects)
        .set({ partitionKey: unassignedPartitionKey })
        .where(
          and(
            eq(nodeRedirects.userId, request.userId),
            inArray(nodeRedirects.toNodeId, orphanNodeIds),
          ),
        ),
    ]);
  }

  const [sourceCount, claimCount, nodeCount, aliasCount, redirectCount] =
    await Promise.all([
      tx.$count(
        sources,
        and(eq(sources.userId, request.userId), isNull(sources.partitionKey)),
      ),
      tx.$count(
        claims,
        and(eq(claims.userId, request.userId), isNull(claims.partitionKey)),
      ),
      tx.$count(
        nodes,
        and(eq(nodes.userId, request.userId), isNull(nodes.partitionKey)),
      ),
      tx.$count(
        aliases,
        and(eq(aliases.userId, request.userId), isNull(aliases.partitionKey)),
      ),
      tx.$count(
        nodeRedirects,
        and(
          eq(nodeRedirects.userId, request.userId),
          isNull(nodeRedirects.partitionKey),
        ),
      ),
    ]);
  if (
    sourceCount > 0 ||
    claimCount > 0 ||
    nodeCount > 0 ||
    aliasCount > 0 ||
    redirectCount > 0
  ) {
    throw new PartitionReclassificationError(
      "MIGRATION_INCOMPLETE",
      "Partition migration cannot finish while legacy evidence remains unclassified",
    );
  }
}
