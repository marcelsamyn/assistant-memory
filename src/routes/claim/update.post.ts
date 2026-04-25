import { defineEventHandler, createError } from "h3";
import { updateClaim } from "~/lib/claim";
import {
  updateClaimRequestSchema,
  updateClaimResponseSchema,
} from "~/lib/schemas/claim";

export default defineEventHandler(async (event) => {
  const { userId, claimId, status } = updateClaimRequestSchema.parse(
    await readBody(event),
  );
  try {
    const result = await updateClaim(userId, claimId, { status });
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: "Claim not found" });
    }
    return updateClaimResponseSchema.parse({ claim: result });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
