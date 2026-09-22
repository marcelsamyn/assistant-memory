import { defineEventHandler, readBody } from "h3";
import { assertPartitionMaintenanceAuthorized } from "~/lib/partition-maintenance-auth";
import { reclassifySourcePartition } from "~/lib/partition-reclassification";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { parseRequestBody } from "~/lib/request-body";
import {
  reclassifySourcePartitionRequestSchema,
  reclassifySourcePartitionResponseSchema,
} from "~/lib/schemas/partition";
import { useDatabase } from "~/utils/db";

/** Idempotently move one source and its provenance-owned graph into a partition. */
export default defineEventHandler(async (event) => {
  assertPartitionMaintenanceAuthorized(event);
  const request = parseRequestBody(
    reclassifySourcePartitionRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  try {
    return reclassifySourcePartitionResponseSchema.parse(
      await reclassifySourcePartition(db, request),
    );
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
