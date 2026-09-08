import { defineEventHandler, readBody } from "h3";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import {
  sourceLifecycleReadModelRetractionSweepRequestSchema,
  sourceLifecycleReadModelRetractionSweepResponseSchema,
} from "~/lib/schemas/source-lifecycle";
import { retryPendingLegacySourceReadModelRetraction } from "~/lib/source-lifecycle";
import { useDatabase } from "~/utils/db";

/** Retracts durable projections left by pre-lifecycle soft-deleted sources. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = sourceLifecycleReadModelRetractionSweepRequestSchema.parse(
    (await readBody(event)) ?? {},
  );
  const result = await retryPendingLegacySourceReadModelRetraction(
    await useDatabase(),
    request.limit,
  );
  return sourceLifecycleReadModelRetractionSweepResponseSchema.parse(result);
});
