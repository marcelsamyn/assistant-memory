import { defineEventHandler } from "h3";
import { retrySourceProcessing } from "~/lib/ingestion/retry-source-processing";
import { retrySourceProcessingRequestSchema } from "~/lib/schemas/source-processing";

export default defineEventHandler(async (event) => {
  const input = retrySourceProcessingRequestSchema.parse(await readBody(event));
  return retrySourceProcessing(input);
});
