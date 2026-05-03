import { defineEventHandler, createError } from "h3";
import { createClaim, InvalidObjectValueError } from "~/lib/claim";
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
    if (e instanceof InvalidObjectValueError) {
      throw createError({
        statusCode: 400,
        statusMessage: e.message,
        data: {
          name: e.name,
          predicate: e.predicate,
          objectValue: e.objectValue,
          allowedValues: e.allowedValues,
        },
      });
    }
    if (e instanceof Error && e.message.includes("not found")) {
      throw createError({ statusCode: 404, statusMessage: e.message });
    }
    throw e;
  }
});
