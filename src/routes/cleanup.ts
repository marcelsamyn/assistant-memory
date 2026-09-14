import { defineEventHandler, readBody } from "h3";
import { PartitionedCleanupGraphUnsupportedError } from "~/lib/jobs/cleanup-graph";
import { batchQueue } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  cleanupRequestSchema,
  cleanupResponseSchema,
} from "~/lib/schemas/cleanup";

export default defineEventHandler(async (event) => {
  const params = cleanupRequestSchema.parse(await readBody(event));
  if (
    getRequestAccessScope(event) === "workspace" ||
    params.partitionKey !== undefined
  ) {
    throw new PartitionedCleanupGraphUnsupportedError();
  }

  await batchQueue.add("cleanup-graph", params);

  console.log(
    `Enqueued 'cleanup-graph' job for user ${params.userId} with params since=${params.since.toISOString()} hopDepth=${params.graphHopDepth}`,
  );

  return cleanupResponseSchema.parse({
    message: `Cleanup-graph job for user ${params.userId} enqueued successfully.`,
  });
});
