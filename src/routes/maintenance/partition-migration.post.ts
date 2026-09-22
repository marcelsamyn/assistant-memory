import { defineEventHandler, readBody } from "h3";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import { setPartitionMigrationState } from "~/lib/partition-migration";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { parseRequestBody } from "~/lib/request-body";
import {
  setPartitionMigrationStateRequestSchema,
  setPartitionMigrationStateResponseSchema,
} from "~/lib/schemas/partition";
import { useDatabase } from "~/utils/db";

/** CAS transition for a user's partition migration state. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = parseRequestBody(
    setPartitionMigrationStateRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  try {
    return setPartitionMigrationStateResponseSchema.parse(
      await setPartitionMigrationState(db, request),
    );
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
