import { defineEventHandler, readBody } from "h3";
import { getPartitionInventory } from "~/lib/partition-inventory";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import {
  partitionInventoryRequestSchema,
  partitionInventoryResponseSchema,
} from "~/lib/schemas/partition";
import { useDatabase } from "~/utils/db";

/** Paginates identity mappings, quarantines, and artifact receipts. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = partitionInventoryRequestSchema.parse(await readBody(event));
  return partitionInventoryResponseSchema.parse(
    await getPartitionInventory(await useDatabase(), request),
  );
});
