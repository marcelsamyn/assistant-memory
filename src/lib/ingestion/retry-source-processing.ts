import { and, eq, isNull } from "drizzle-orm";
import { createError } from "h3";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import {
  getSourceIngestionOperationById,
  retrySourceIngestionOperation,
} from "~/lib/ingestion/source-processing";
import {
  PartitionAccessError,
  preparePartitionWrite,
} from "~/lib/partition-access";
import { batchQueue } from "~/lib/queues";
import type { MemoryAccessScope } from "~/lib/schemas/partition";
import {
  retrySourceProcessingResponseSchema,
  type RetrySourceProcessingRequest,
  type RetrySourceProcessingResponse,
  type SourceProcessing,
} from "~/lib/schemas/source-processing";
import { sourceMetadataSchema } from "~/lib/sources";
import { useDatabase } from "~/utils/db";

/** Retry a failed job or restore a queued receipt whose job was never saved. */
export async function retrySourceProcessing(
  input: RetrySourceProcessingRequest & { accessScope?: MemoryAccessScope },
): Promise<RetrySourceProcessingResponse> {
  const db = await useDatabase();
  const operationInput = {
    db,
    userId: input.userId,
    operationId: input.operationId,
    ...(input.partitionKey !== undefined
      ? { partitionKey: input.partitionKey }
      : {}),
    ...(input.accessScope !== undefined
      ? { accessScope: input.accessScope }
      : {}),
  };
  const operation = await getSourceIngestionOperationById(operationInput);
  if (!operation)
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      "Source ingestion operation was not found",
    );
  // A workspace read may find a legacy NULL receipt while migration is still
  // running. Retry can restore a missing job or mutate the receipt, so fence
  // that concrete write scope before touching Redis or the database again.
  await preparePartitionWrite(
    db,
    input.userId,
    operation.partitionKey ?? undefined,
  );
  const job = await batchQueue.getJob(input.operationId);
  if (!job) {
    await restoreQueuedSourceJob(db, input.userId, operation);
    return retrySourceProcessingResponseSchema.parse({ processing: operation });
  }
  const state = await job.getState();
  if (state === "active")
    throw createError({
      statusCode: 409,
      statusMessage:
        "The processing job is still active; retry after it reaches a terminal state",
    });
  if (state !== "failed" && state !== "completed" && state !== "waiting")
    throw createError({
      statusCode: 409,
      statusMessage: "The processing job is not retryable",
    });
  // Content rejection finishes the queue job normally but fails the receipt.
  // Queued also covers recovery after the receipt reopened but Redis failed.
  if (
    state === "completed" &&
    operation.status !== "failed" &&
    operation.status !== "queued"
  )
    throw createError({
      statusCode: 409,
      statusMessage:
        "Only a failed processing receipt can restart a completed job",
    });
  const processing = await retrySourceIngestionOperation(operationInput);
  if (state === "failed" || state === "completed") await job.retry(state);
  return retrySourceProcessingResponseSchema.parse({ processing });
}

async function restoreQueuedSourceJob(
  db: DrizzleDB,
  userId: string,
  operation: SourceProcessing,
): Promise<void> {
  if (operation.status !== "queued")
    throw createError({
      statusCode: 409,
      statusMessage:
        "Only a queued receipt can restore a missing processing job",
    });
  const [source] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.id, operation.sourceId),
        isNull(sources.deletedAt),
        operation.partitionKey === null
          ? isNull(sources.partitionKey)
          : eq(sources.partitionKey, operation.partitionKey),
      ),
    )
    .limit(1);
  if (!source || source.version !== operation.sourceVersion)
    throw new PartitionAccessError(
      "SOURCE_VERSION_CONFLICT",
      "The source changed before its queued job could be restored",
    );
  if (source.lastIngestedAt === null)
    throw createError({
      statusCode: 409,
      statusMessage: "The source has no retained ingestion timestamp",
    });
  const metadata = sourceMetadataSchema.parse(source.metadata ?? {});
  const common = {
    userId,
    partitionKey: operation.partitionKey ?? undefined,
    sourceId: source.id,
    expectedSourceVersion: operation.sourceVersion,
    externalId: source.externalId,
    operationId: operation.operationId,
    timestamp: source.lastIngestedAt.toISOString(),
  };
  const options = {
    jobId: operation.operationId,
    attempts: 3,
    backoff: { type: "exponential", delay: 1_000 },
  };
  if (metadata.documentIngestion !== undefined) {
    await batchQueue.add(
      "ingest-document",
      {
        ...common,
        ...metadata.documentIngestion,
        author: metadata.author,
        title: metadata.title,
      },
      options,
    );
    return;
  }
  const file = z
    .object({ filename: z.string().min(1), mimeType: z.string().min(1) })
    .safeParse(metadata);
  if (file.success) {
    await batchQueue.add("ingest-file", { ...common, ...file.data }, options);
    return;
  }
  throw createError({
    statusCode: 409,
    statusMessage:
      "The source has no retained conversion settings; resubmit the original ingestion request",
  });
}
