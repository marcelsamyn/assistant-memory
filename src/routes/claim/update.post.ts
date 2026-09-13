import { defineEventHandler, createError } from "h3";
import { resolveClaimPartition, updateClaim } from "~/lib/claim";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  updateClaimRequestSchema,
  updateClaimResponseSchema,
} from "~/lib/schemas/claim";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, claimId, status } =
    updateClaimRequestSchema.parse(await readBody(event));
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
    const result = await updateClaim(
      userId,
      claimId,
      { status },
      resolution.partitionKey,
    );
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: "Claim not found" });
    }
    return updateClaimResponseSchema.parse({ claim: result });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throwPartitionRouteError(e);
  }
});
