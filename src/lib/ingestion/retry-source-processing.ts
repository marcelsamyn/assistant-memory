import { createError } from "h3";
import {
  getSourceIngestionOperationById,
  retrySourceIngestionOperation,
} from "~/lib/ingestion/source-processing";
import { PartitionAccessError } from "~/lib/partition-access";
import { batchQueue } from "~/lib/queues";
import {
  retrySourceProcessingResponseSchema,
  type RetrySourceProcessingRequest,
  type RetrySourceProcessingResponse,
} from "~/lib/schemas/source-processing";
import { useDatabase } from "~/utils/db";

/** Reopen an owned failed receipt and reschedule its retained processing job. */
export async function retrySourceProcessing(
  input: RetrySourceProcessingRequest,
): Promise<RetrySourceProcessingResponse> {
  const db = await useDatabase();
  const operationInput = {
    db,
    userId: input.userId,
    operationId: input.operationId,
    ...(input.partitionKey !== undefined
      ? { partitionKey: input.partitionKey }
      : {}),
  };
  const operation = await getSourceIngestionOperationById(operationInput);
  if (!operation)
    throw new PartitionAccessError(
      "PARTITION_UNAUTHORIZED",
      "Source ingestion operation was not found",
    );
  const job = await batchQueue.getJob(input.operationId);
  if (!job)
    throw createError({
      statusCode: 409,
      statusMessage: "The retained processing job is unavailable for retry",
    });
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
