import { defineEventHandler, createError } from "h3";
import { deleteClaim, resolveClaimPartition } from "~/lib/claim";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  deleteClaimRequestSchema,
  deleteClaimResponseSchema,
} from "~/lib/schemas/claim";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, claimId } = parseRequestBody(
    deleteClaimRequestSchema,
    await readBody(event),
  );
  const accessScope = getRequestAccessScope(event);
  try {
    const resolution = await resolveClaimPartition(
      await useDatabase(),
      userId,
      claimId,
      partitionKey,
      accessScope,
    );
    if (!resolution.found) {
      throw createError({ statusCode: 404, statusMessage: "Claim not found" });
    }
    const deleted = await deleteClaim(userId, claimId, resolution.partitionKey);
    if (!deleted) {
      throw createError({ statusCode: 404, statusMessage: "Claim not found" });
    }
    return deleteClaimResponseSchema.parse({ deleted: true });
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
