import { defineEventHandler, readBody } from "h3";
import { getPartitionProgress } from "~/lib/partition-inventory";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import {
  partitionProgressRequestSchema,
  partitionProgressResponseSchema,
} from "~/lib/schemas/partition";
import { useDatabase } from "~/utils/db";

/** Returns authoritative migration and optional source version state. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = partitionProgressRequestSchema.parse(await readBody(event));
  return partitionProgressResponseSchema.parse(
    await getPartitionProgress(await useDatabase(), request),
  );
});
