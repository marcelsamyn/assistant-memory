import { and, eq } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import {
  preparePartitionWrite,
  withSourceWriteFence,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import { sourceService, type SourceCreateInput } from "~/lib/sources";
import { Scope, SourceType } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import {
  getSourceServiceOverride,
  shouldSkipJobEnqueue,
} from "~/utils/test-overrides";

export interface SourceInput {
  externalId: string;
  timestamp: Date;
  content?: string;
  fileBuffer?: Buffer;
  contentType?: string;
  metadata?: SourceCreateInput["metadata"];
}

export interface InsertedSourceRef {
  externalId: string;
  sourceId: TypeId<"source">;
  statedAt?: Date | undefined;
}

export async function insertNewSources(params: {
  db: DrizzleDB;
  userId: string;
  partitionKey?: ContextPartitionKey;
  parentSourceType: SourceType;
  parentSourceId: string;
  childSourceType: SourceType;
  scope?: Scope;
  childSources: SourceInput[];
  /** Authority for a pre-created parent owned by a queued ingestion job. */
  parentWriteFence?: {
    sourceId: TypeId<"source">;
    expectedSourceVersion: number;
  };
}): Promise<{
  sourceId: TypeId<"source">;
  newSourceSourceIds: string[];
  sourceRefs: InsertedSourceRef[];
}> {
  const {
    db,
    userId,
    partitionKey,
    parentSourceType,
    parentSourceId,
    childSourceType,
    scope = "personal",
    childSources,
    parentWriteFence,
  } = params;

  await preparePartitionWrite(db, userId, partitionKey);

  const parentSource = await withSourceWriteFence(
    db,
    {
      userId,
      sources: [],
      sourceIdentities: [
        { userId, sourceType: parentSourceType, externalId: parentSourceId },
      ],
    },
    async (tx) => {
      const [insertedParent] = await tx
        .insert(sources)
        .values({
          userId,
          partitionKey,
          type: parentSourceType,
          externalId: parentSourceId,
          scope,
          lastIngestedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [sources.userId, sources.type, sources.externalId],
        })
        .returning();

      return (
        insertedParent ??
        (
          await tx
            .select()
            .from(sources)
            .where(
              and(
                eq(sources.userId, userId),
                eq(sources.type, parentSourceType),
                eq(sources.externalId, parentSourceId),
              ),
            )
            .limit(1)
        )[0]
      );
    },
  );

  if (!parentSource) {
    throw new Error("Failed to upsert parent source");
  }
  if (parentSource.partitionKey !== (partitionKey ?? null)) {
    throw new Error(
      `Source ${parentSource.id} already belongs to a different memory partition`,
    );
  }
  if (
    parentWriteFence !== undefined &&
    parentWriteFence.sourceId !== parentSource.id
  ) {
    throw new Error(
      "Transcript parent authority does not match the persisted source",
    );
  }
  const parentVersion = await withSourceWriteFence(
    db,
    {
      userId,
      sources: [
        parentWriteFence ?? {
          sourceId: parentSource.id,
          expectedSourceVersion: parentSource.version,
        },
      ],
    },
    async (tx) => {
      const [updated] = await tx
        .update(sources)
        .set({ lastIngestedAt: new Date() })
        .where(eq(sources.id, parentSource.id))
        .returning({ version: sources.version });
      if (!updated) throw new Error("Locked parent source disappeared");
      return updated.version;
    },
  );

  // Map to SourceService inputs
  const childInputs: SourceCreateInput[] = childSources.map((cs) => {
    const input: SourceCreateInput = {
      userId,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      sourceType: childSourceType,
      externalId: cs.externalId,
      parentId: parentSource.id,
      scope,
      timestamp: cs.timestamp,
    };
    if (cs.metadata !== undefined) input.metadata = cs.metadata;
    if (cs.content !== undefined) input.content = cs.content;
    if (cs.fileBuffer !== undefined) input.fileBuffer = cs.fileBuffer;
    if (cs.contentType !== undefined) input.contentType = cs.contentType;
    return input;
  });

  // Delegate insertion & storage. Eval harness can swap in a SQL-only stub
  // via `setSourceServiceOverride` so transcript ingestion runs without MinIO.
  const service = getSourceServiceOverride() ?? sourceService;
  const { successes: newInternalIds, failures } = await service.insertMany(
    childInputs,
    {
      userId,
      source: {
        sourceId: parentSource.id,
        expectedSourceVersion: parentVersion,
      },
    },
  );
  if (failures.length) {
    console.warn("Some sources failed to archive:", failures);
  }

  // Fetch external IDs for inserted sources
  const insertedRows = await db.query.sources.findMany({
    where: (src, { inArray }) => inArray(src.id, newInternalIds),
  });
  const newSourceSourceIds = insertedRows.map((r) => r.externalId);
  const sourceRefs = insertedRows.map((row) => ({
    externalId: row.externalId,
    sourceId: row.id,
    ...(row.lastIngestedAt !== null ? { statedAt: row.lastIngestedAt } : {}),
  }));

  // Best-effort, fire-and-forget container titling. Guarded inside the job, so
  // enqueuing is safe and idempotent. Eval/probe runs set skipJobEnqueue so
  // they do not import queues or let title generation consume LLM stubs.
  if (!shouldSkipJobEnqueue()) {
    const { batchQueue } = await import("../queues");
    await batchQueue.add(
      "generate-source-title",
      { userId, sourceId: parentSource.id },
      {
        attempts: 2,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: 20,
      },
    );
  }

  return { sourceId: parentSource.id, newSourceSourceIds, sourceRefs };
}
