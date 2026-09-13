import { defineEventHandler } from "h3";
import { retrySourceProcessing } from "~/lib/ingestion/retry-source-processing";
import { resolveSourceProcessingPartition } from "~/lib/ingestion/source-processing";
import { PartitionAccessError } from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import { retrySourceProcessingRequestSchema } from "~/lib/schemas/source-processing";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const input = retrySourceProcessingRequestSchema.parse(await readBody(event));
  const accessScope = getRequestAccessScope(event);
  try {
    let partitionKey = input.partitionKey;
    if (accessScope === "workspace" && partitionKey === undefined) {
      const resolution = await resolveSourceProcessingPartition({
        db: await useDatabase(),
        userId: input.userId,
        operationId: input.operationId,
        accessScope,
      });
      if (!resolution.found) {
        throw new PartitionAccessError(
          "PARTITION_UNAUTHORIZED",
          "Source ingestion operation was not found",
        );
      }
      partitionKey = resolution.partitionKey;
    }
    return await retrySourceProcessing({
      ...input,
      ...(accessScope === "workspace" ? { accessScope } : {}),
      ...(partitionKey !== undefined ? { partitionKey } : {}),
    });
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
