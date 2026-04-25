import { defineEventHandler, createError } from "h3";
import { createClaim } from "~/lib/claim";
import {
  createClaimRequestSchema,
  createClaimResponseSchema,
} from "~/lib/schemas/claim";

export default defineEventHandler(async (event) => {
  const claimInput = createClaimRequestSchema.parse(await readBody(event));
  try {
    const claim = await createClaim(claimInput);
    return createClaimResponseSchema.parse({ claim });
  } catch (e) {
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
