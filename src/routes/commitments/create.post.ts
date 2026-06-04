import { defineEventHandler, createError } from "h3";
import { NodesNotFoundError } from "~/lib/claim";
import { createCommitment } from "~/lib/commitments";
import {
  createCommitmentRequestSchema,
  createCommitmentResponseSchema,
} from "~/lib/schemas/create-commitment";

export default defineEventHandler(async (event) => {
  const params = createCommitmentRequestSchema.parse(await readBody(event));
  try {
    const result = await createCommitment(params);
    return createCommitmentResponseSchema.parse(result);
  } catch (e) {
    if (e instanceof NodesNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, missingNodeIds: e.missingNodeIds },
      });
    }
    throw e;
  }
});
