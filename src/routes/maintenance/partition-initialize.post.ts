import { defineEventHandler, readBody } from "h3";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import { initializePartitionedUser } from "~/lib/partition-migration";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import {
  initializePartitionedUserRequestSchema,
  initializePartitionedUserResponseSchema,
} from "~/lib/schemas/partition";
import { useDatabase } from "~/utils/db";

/** Enables partition enforcement only while creating a brand-new identity. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = initializePartitionedUserRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  try {
    return initializePartitionedUserResponseSchema.parse(
      await initializePartitionedUser(db, request),
    );
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
