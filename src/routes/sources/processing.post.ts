import { defineEventHandler } from "h3";
import {
  getSourceIngestionOperationById,
  projectInterruptedSourceProcessing,
  resolveSourceProcessingPartition,
} from "~/lib/ingestion/source-processing";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  getSourceProcessingRequestSchema,
  getSourceProcessingResponseSchema,
} from "~/lib/schemas/source-processing";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, operationId } =
    getSourceProcessingRequestSchema.parse(await readBody(event));
  const accessScope = getRequestAccessScope(event);
  const db = await useDatabase();
  try {
    let resolvedPartitionKey = partitionKey;
    if (accessScope === "workspace" && partitionKey === undefined) {
      const resolution = await resolveSourceProcessingPartition({
        db,
        userId,
        operationId,
        accessScope,
      });
      if (!resolution.found) {
        return getSourceProcessingResponseSchema.parse({ processing: null });
      }
      resolvedPartitionKey = resolution.partitionKey;
    }
    const processing = await getSourceIngestionOperationById({
      db,
      userId,
      ...(resolvedPartitionKey !== undefined
        ? { partitionKey: resolvedPartitionKey }
        : {}),
      operationId,
      ...(accessScope === "workspace" ? { accessScope } : {}),
    });
    const effectiveProcessing = processing
      ? await projectInterruptedSourceProcessing({
          db,
          userId,
          operation: processing,
          ...(resolvedPartitionKey !== undefined
            ? { partitionKey: resolvedPartitionKey }
            : {}),
          ...(accessScope === "workspace" ? { accessScope } : {}),
        })
      : null;
    return getSourceProcessingResponseSchema.parse({
      processing: effectiveProcessing,
    });
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
