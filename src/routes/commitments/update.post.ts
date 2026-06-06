import { defineEventHandler, createError } from "h3";
import { updateCommitment, TaskNotFoundError } from "~/lib/commitments";
import {
  updateCommitmentRequestSchema,
  updateCommitmentResponseSchema,
} from "~/lib/schemas/update-commitment";

export default defineEventHandler(async (event) => {
  const params = updateCommitmentRequestSchema.parse(await readBody(event));
  try {
    const result = await updateCommitment(params);
    return updateCommitmentResponseSchema.parse(result);
  } catch (e) {
    if (e instanceof TaskNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, taskId: e.taskId },
      });
    }
    throw e;
  }
});
