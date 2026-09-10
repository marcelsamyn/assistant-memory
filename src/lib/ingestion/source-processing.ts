import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { DrizzleDB } from "~/db";
import { sourceIngestionOperations, sources } from "~/db/schema";
import {
  PartitionAccessError,
  assertPartitionReadAllowed,
  withSourceWriteFence,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type {
  SourceProcessing,
  SourceProcessingStage,
} from "~/lib/schemas/source-processing";
import type { TypeId } from "~/types/typeid";

export type SourceIngestionOperationRow =
  typeof sourceIngestionOperations.$inferSelect;

export function hashSourceContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toSourceProcessing(
  row: SourceIngestionOperationRow,
): SourceProcessing {
  return {
    operationId: row.operationId,
    sourceId: row.sourceId,
    partitionKey: row.partitionKey,
    status: row.status,
    stage: row.stage,
    sourceVersion: row.sourceVersion,
    attempt: row.attempt,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function assertSourcePartitionMatches(
  sourcePartitionKey: ContextPartitionKey | null,
  requestedPartitionKey: ContextPartitionKey | undefined,
): void {
  if (sourcePartitionKey !== (requestedPartitionKey ?? null)) {
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      "Source does not belong to the requested memory partition",
    );
  }
}

/** Creates or reuses the receipt for one exact content revision. */
export async function createSourceIngestionOperation(input: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  sourceId: TypeId<"source">;
  externalId: string;
  contentHash: string;
}): Promise<SourceProcessing> {
  await assertPartitionReadAllowed(input.db, input.userId, input.partitionKey);
  return input.db.transaction(async (tx) => {
    const [source] = await tx
      .select({
        partitionKey: sources.partitionKey,
        version: sources.version,
        deletedAt: sources.deletedAt,
      })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .for("update")
      .limit(1);
    if (!source || source.deletedAt !== null) {
      throw new PartitionAccessError(
        "SOURCE_TOMBSTONED",
        "Cannot create processing for a removed source",
      );
    }
    assertSourcePartitionMatches(source.partitionKey, input.partitionKey);

    const [existing] = await tx
      .select()
      .from(sourceIngestionOperations)
      .where(
        and(
          eq(sourceIngestionOperations.userId, input.userId),
          eq(sourceIngestionOperations.sourceId, input.sourceId),
          eq(sourceIngestionOperations.contentHash, input.contentHash),
        ),
      )
      .limit(1);
    if (existing) return toSourceProcessing(existing);

    const [updatedSource] = await tx
      .update(sources)
      .set({ status: "pending" })
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .returning({ version: sources.version });
    if (!updatedSource) {
      throw new Error("Source disappeared before processing was accepted");
    }

    const [operation] = await tx
      .insert(sourceIngestionOperations)
      .values({
        operationId: randomUUID(),
        userId: input.userId,
        sourceId: input.sourceId,
        partitionKey: source.partitionKey,
        externalId: input.externalId,
        contentHash: input.contentHash,
        sourceVersion: updatedSource.version,
        status: "queued",
        stage: "content",
        attempt: 0,
      })
      .returning();
    if (!operation)
      throw new Error("Failed to create source ingestion operation");
    return toSourceProcessing(operation);
  });
}

/** Finds an exact revision without exposing content or cross-user rows. */
export async function findSourceIngestionOperation(input: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  sourceId: TypeId<"source">;
  contentHash: string;
}): Promise<SourceProcessing | null> {
  await assertPartitionReadAllowed(input.db, input.userId, input.partitionKey);
  const [operation] = await input.db
    .select()
    .from(sourceIngestionOperations)
    .where(
      and(
        eq(sourceIngestionOperations.userId, input.userId),
        eq(sourceIngestionOperations.sourceId, input.sourceId),
        eq(sourceIngestionOperations.contentHash, input.contentHash),
        input.partitionKey === undefined
          ? isNull(sourceIngestionOperations.partitionKey)
          : eq(sourceIngestionOperations.partitionKey, input.partitionKey),
      ),
    )
    .orderBy(
      desc(sourceIngestionOperations.createdAt),
      desc(sourceIngestionOperations.operationId),
    )
    .limit(1);
  return operation ? toSourceProcessing(operation) : null;
}

export async function getSourceIngestionOperation(input: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  sourceId: TypeId<"source">;
  operationId?: string;
}): Promise<SourceProcessing | null> {
  await assertPartitionReadAllowed(input.db, input.userId, input.partitionKey);
  const [operation] = await input.db
    .select()
    .from(sourceIngestionOperations)
    .where(
      and(
        eq(sourceIngestionOperations.userId, input.userId),
        eq(sourceIngestionOperations.sourceId, input.sourceId),
        input.operationId
          ? eq(sourceIngestionOperations.operationId, input.operationId)
          : undefined,
        input.partitionKey === undefined
          ? isNull(sourceIngestionOperations.partitionKey)
          : eq(sourceIngestionOperations.partitionKey, input.partitionKey),
      ),
    )
    .orderBy(
      desc(sourceIngestionOperations.createdAt),
      desc(sourceIngestionOperations.operationId),
    )
    .limit(1);
  return operation ? toSourceProcessing(operation) : null;
}

/** Looks up a retained receipt without requiring the source row to exist. */
export async function getSourceIngestionOperationById(input: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  operationId: string;
}): Promise<SourceProcessing | null> {
  await assertPartitionReadAllowed(input.db, input.userId, input.partitionKey);
  const [operation] = await input.db
    .select()
    .from(sourceIngestionOperations)
    .where(
      and(
        eq(sourceIngestionOperations.userId, input.userId),
        eq(sourceIngestionOperations.operationId, input.operationId),
        input.partitionKey === undefined
          ? isNull(sourceIngestionOperations.partitionKey)
          : eq(sourceIngestionOperations.partitionKey, input.partitionKey),
      ),
    )
    .limit(1);
  return operation ? toSourceProcessing(operation) : null;
}

/** Marks extraction as running and advances only the mutable source fence. */
export async function markSourceIngestionProcessing(input: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  sourceId: TypeId<"source">;
  operationId: string;
  expectedSourceVersion?: number;
}): Promise<SourceProcessing> {
  return withSourceWriteFence(
    input.db,
    {
      userId: input.userId,
      ...(input.partitionKey !== undefined
        ? { partitionKey: input.partitionKey }
        : {}),
      sources: [{ sourceId: input.sourceId }],
    },
    async (tx, sourceVersions) => {
      const [operation] = await tx
        .select()
        .from(sourceIngestionOperations)
        .where(
          and(
            eq(sourceIngestionOperations.userId, input.userId),
            eq(sourceIngestionOperations.sourceId, input.sourceId),
            eq(sourceIngestionOperations.operationId, input.operationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!operation)
        throw new Error("Source ingestion operation was not found");
      if (operation.status === "purged") return toSourceProcessing(operation);
      if (operation.status === "completed" || operation.status === "failed") {
        return toSourceProcessing(operation);
      }
      const currentSourceVersion = sourceVersions.get(input.sourceId);
      if (currentSourceVersion === undefined) {
        throw new Error("Source disappeared before processing started");
      }
      if (
        currentSourceVersion !== operation.sourceVersion ||
        (await isSuperseded(tx, operation))
      ) {
        const [superseded] = await tx
          .update(sourceIngestionOperations)
          .set({
            status: "failed",
            errorCode: "SUPERSEDED_OPERATION",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(sourceIngestionOperations.operationId, input.operationId))
          .returning();
        if (!superseded)
          throw new Error("Source ingestion operation disappeared");
        return toSourceProcessing(superseded);
      }
      let sourceVersion = currentSourceVersion;
      const [source] = await tx
        .select({ status: sources.status })
        .from(sources)
        .where(
          and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
        )
        .limit(1);
      if (!source)
        throw new Error("Source disappeared before processing started");
      if (source.status !== "processing") {
        const [updatedSource] = await tx
          .update(sources)
          .set({ status: "processing" })
          .where(
            and(
              eq(sources.userId, input.userId),
              eq(sources.id, input.sourceId),
            ),
          )
          .returning({ version: sources.version });
        if (!updatedSource)
          throw new Error("Source disappeared before processing started");
        sourceVersion = updatedSource.version;
      }
      const [updated] = await tx
        .update(sourceIngestionOperations)
        .set({
          status: "processing",
          stage: "content",
          attempt: operation.attempt + 1,
          sourceVersion,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceIngestionOperations.userId, input.userId),
            eq(sourceIngestionOperations.operationId, input.operationId),
            or(
              eq(sourceIngestionOperations.status, "queued"),
              eq(sourceIngestionOperations.status, "processing"),
            ),
          ),
        )
        .returning();
      if (!updated) return toSourceProcessing(operation);
      return toSourceProcessing(updated);
    },
  );
}

/** Records that content is ready and graph extraction has started. */
export async function markSourceIngestionExtractionStarted(input: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  sourceId: TypeId<"source">;
  operationId: string;
}): Promise<SourceProcessing> {
  return withSourceWriteFence(
    input.db,
    {
      userId: input.userId,
      ...(input.partitionKey !== undefined
        ? { partitionKey: input.partitionKey }
        : {}),
      sources: [{ sourceId: input.sourceId }],
    },
    async (tx, sourceVersions) => {
      const [operation] = await tx
        .select()
        .from(sourceIngestionOperations)
        .where(
          and(
            eq(sourceIngestionOperations.userId, input.userId),
            eq(sourceIngestionOperations.sourceId, input.sourceId),
            eq(sourceIngestionOperations.operationId, input.operationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!operation)
        throw new Error("Source ingestion operation was not found");
      if (["completed", "failed", "purged"].includes(operation.status)) {
        return toSourceProcessing(operation);
      }
      if (
        sourceVersions.get(input.sourceId) !== operation.sourceVersion ||
        (await isSuperseded(tx, operation))
      ) {
        const [superseded] = await tx
          .update(sourceIngestionOperations)
          .set({
            status: "failed",
            errorCode: "SUPERSEDED_OPERATION",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(sourceIngestionOperations.operationId, input.operationId))
          .returning();
        if (!superseded)
          throw new Error("Source ingestion operation disappeared");
        return toSourceProcessing(superseded);
      }
      const [updated] = await tx
        .update(sourceIngestionOperations)
        .set({ stage: "extraction", updatedAt: new Date() })
        .where(
          and(
            eq(sourceIngestionOperations.userId, input.userId),
            eq(sourceIngestionOperations.sourceId, input.sourceId),
            eq(sourceIngestionOperations.operationId, input.operationId),
            eq(sourceIngestionOperations.status, "processing"),
          ),
        )
        .returning();
      if (!updated) return toSourceProcessing(operation);
      return toSourceProcessing(updated);
    },
  );
}

/** Records a source-row version advanced by work owned by this operation. */
export async function advanceSourceIngestionOperationVersion(input: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  operationId: string;
  sourceVersion: number;
}): Promise<void> {
  await input.db
    .update(sourceIngestionOperations)
    .set({ sourceVersion: input.sourceVersion, updatedAt: new Date() })
    .where(
      and(
        eq(sourceIngestionOperations.userId, input.userId),
        eq(sourceIngestionOperations.sourceId, input.sourceId),
        eq(sourceIngestionOperations.operationId, input.operationId),
        eq(sourceIngestionOperations.status, "processing"),
      ),
    );
}

async function isSuperseded(
  tx: Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0],
  operation: SourceIngestionOperationRow,
): Promise<boolean> {
  const [newer] = await tx
    .select({ operationId: sourceIngestionOperations.operationId })
    .from(sourceIngestionOperations)
    .where(
      and(
        eq(sourceIngestionOperations.userId, operation.userId),
        eq(sourceIngestionOperations.sourceId, operation.sourceId),
        or(
          gt(sourceIngestionOperations.createdAt, operation.createdAt),
          and(
            eq(sourceIngestionOperations.createdAt, operation.createdAt),
            gt(sourceIngestionOperations.operationId, operation.operationId),
          ),
        ),
      ),
    )
    .limit(1);
  return newer !== undefined;
}

async function finishSourceIngestionOperation(input: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  operationId: string;
  status: "completed" | "failed";
  errorCode?: string;
  stage?: SourceProcessingStage;
  expectedSourceVersion?: number;
}): Promise<SourceProcessing> {
  return withSourceWriteFence(
    input.db,
    {
      userId: input.userId,
      sources: [
        {
          sourceId: input.sourceId,
          ...(input.expectedSourceVersion !== undefined
            ? { expectedSourceVersion: input.expectedSourceVersion }
            : {}),
        },
      ],
    },
    async (tx) => {
      const [operation] = await tx
        .select()
        .from(sourceIngestionOperations)
        .where(
          and(
            eq(sourceIngestionOperations.userId, input.userId),
            eq(sourceIngestionOperations.sourceId, input.sourceId),
            eq(sourceIngestionOperations.operationId, input.operationId),
          ),
        )
        .for("update")
        .limit(1);
      if (!operation)
        throw new Error("Source ingestion operation was not found");
      if (["completed", "failed", "purged"].includes(operation.status)) {
        return toSourceProcessing(operation);
      }
      if (await isSuperseded(tx, operation)) {
        const [superseded] = await tx
          .update(sourceIngestionOperations)
          .set({
            status: "failed",
            errorCode: "SUPERSEDED_OPERATION",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(sourceIngestionOperations.operationId, input.operationId))
          .returning();
        if (!superseded)
          throw new Error("Source ingestion operation disappeared");
        return toSourceProcessing(superseded);
      }
      const [updatedSource] = await tx
        .update(sources)
        .set({ status: input.status })
        .where(
          and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
        )
        .returning({ version: sources.version });
      if (!updatedSource)
        throw new Error("Source disappeared before processing completed");
      const now = new Date();
      const [updated] = await tx
        .update(sourceIngestionOperations)
        .set({
          status: input.status,
          stage: input.stage ?? operation.stage,
          sourceVersion: updatedSource.version,
          errorCode: input.errorCode,
          updatedAt: now,
          completedAt: now,
        })
        .where(eq(sourceIngestionOperations.operationId, input.operationId))
        .returning();
      if (!updated) throw new Error("Source ingestion operation disappeared");
      return toSourceProcessing(updated);
    },
  );
}

export function completeSourceIngestionOperation(
  input: Omit<
    Parameters<typeof finishSourceIngestionOperation>[0],
    "status" | "errorCode"
  >,
): Promise<SourceProcessing> {
  return finishSourceIngestionOperation({ ...input, status: "completed" });
}

export function failSourceIngestionOperation(
  input: Omit<
    Parameters<typeof finishSourceIngestionOperation>[0],
    "status"
  > & {
    errorCode: string;
  },
): Promise<SourceProcessing> {
  return finishSourceIngestionOperation({ ...input, status: "failed" });
}

/** Used by source purge while source rows are still locked in the same tx. */
export async function purgeSourceIngestionOperations(
  tx: Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0],
  userId: string,
  sourceIds: readonly TypeId<"source">[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  await tx
    .update(sourceIngestionOperations)
    .set({
      status: "purged",
      errorCode: "SOURCE_PURGED",
      updatedAt: new Date(),
      completedAt: new Date(),
    })
    .where(
      and(
        eq(sourceIngestionOperations.userId, userId),
        inArray(sourceIngestionOperations.sourceId, [...sourceIds]),
      ),
    );
}
