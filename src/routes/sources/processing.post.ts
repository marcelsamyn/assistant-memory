import { defineEventHandler } from "h3";
import {
  getPublicSourceProcessing,
  resolveSourceProcessingPartition,
} from "~/lib/ingestion/source-processing";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  getSourceProcessingRequestSchema,
  getSourceProcessingResponseSchema,
} from "~/lib/schemas/source-processing";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, operationId } = parseRequestBody(
    getSourceProcessingRequestSchema,
    await readBody(event),
  );
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
    const processing = await getPublicSourceProcessing({
      db,
      userId,
      ...(resolvedPartitionKey !== undefined
        ? { partitionKey: resolvedPartitionKey }
        : {}),
      operationId,
      ...(accessScope === "workspace" ? { accessScope } : {}),
    });
    return getSourceProcessingResponseSchema.parse({
      processing,
    });
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
