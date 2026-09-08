import { defineEventHandler, readBody } from "h3";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import {
  sourceLifecycleStorageCleanupSweepRequestSchema,
  sourceLifecycleStorageCleanupSweepResponseSchema,
} from "~/lib/schemas/source-lifecycle";
import { retryPendingSourceTombstoneStorageCleanup } from "~/lib/source-lifecycle";
import { sourceService } from "~/lib/sources";
import { useDatabase } from "~/utils/db";

/** Retries opaque tombstone cleanup receipts after a storage failure. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = sourceLifecycleStorageCleanupSweepRequestSchema.parse(
    (await readBody(event)) ?? {},
  );
  const db = await useDatabase();
  const result = await retryPendingSourceTombstoneStorageCleanup(
    db,
    (objectKey) => sourceService.deleteRawBlobObjectKeyIfPresent(objectKey),
    request.limit,
  );
  return sourceLifecycleStorageCleanupSweepResponseSchema.parse(result);
});
