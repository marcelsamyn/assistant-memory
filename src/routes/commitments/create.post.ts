import { defineEventHandler, createError } from "h3";
import { NodesNotFoundError } from "~/lib/claim";
import {
  createCommitment,
  CrossPartitionCommitmentError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import {
  createCommitmentRequestSchema,
  createCommitmentResponseSchema,
} from "~/lib/schemas/create-commitment";

export default defineEventHandler(async (event) => {
  const params = createCommitmentRequestSchema.parse(await readBody(event));
  try {
    const result = await createCommitment(
      withRequestAccessScope(event, params),
    );
    return createCommitmentResponseSchema.parse(result);
  } catch (e) {
    if (e instanceof NodesNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, missingNodeIds: e.missingNodeIds },
      });
    }
    if (e instanceof CrossPartitionCommitmentError) {
      throw createError({ statusCode: 409, statusMessage: e.message });
    }
    throw e;
  }
});
