import { defineEventHandler } from "h3";
import { getSourceIngestionOperationById } from "~/lib/ingestion/source-processing";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import {
  getSourceProcessingRequestSchema,
  getSourceProcessingResponseSchema,
} from "~/lib/schemas/source-processing";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, operationId } =
    getSourceProcessingRequestSchema.parse(await readBody(event));
  const db = await useDatabase();
  try {
    const processing = await getSourceIngestionOperationById({
      db,
      userId,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      operationId,
    });
    return getSourceProcessingResponseSchema.parse({ processing });
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
