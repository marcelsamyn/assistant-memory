import { defineEventHandler, createError } from "h3";
import { deleteClaim } from "~/lib/claim";
import {
  deleteClaimRequestSchema,
  deleteClaimResponseSchema,
} from "~/lib/schemas/claim";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, claimId } = deleteClaimRequestSchema.parse(
    await readBody(event),
  );
  const deleted = await deleteClaim(userId, claimId, partitionKey);
  if (!deleted) {
    throw createError({ statusCode: 404, statusMessage: "Claim not found" });
  }
  return deleteClaimResponseSchema.parse({ deleted: true });
});
