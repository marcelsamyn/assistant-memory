import { defineEventHandler } from "h3";
import { retrySourceProcessing } from "~/lib/ingestion/retry-source-processing";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { retrySourceProcessingRequestSchema } from "~/lib/schemas/source-processing";

export default defineEventHandler(async (event) => {
  const input = retrySourceProcessingRequestSchema.parse(await readBody(event));
  try {
    return await retrySourceProcessing(input);
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
