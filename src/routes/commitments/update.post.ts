import { defineEventHandler, createError } from "h3";
import {
  CrossPartitionCommitmentError,
  updateCommitment,
  TaskNotFoundError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import {
  updateCommitmentRequestSchema,
  updateCommitmentResponseSchema,
} from "~/lib/schemas/update-commitment";

export default defineEventHandler(async (event) => {
  const params = updateCommitmentRequestSchema.parse(await readBody(event));
  try {
    const result = await updateCommitment(
      withRequestAccessScope(event, params),
    );
    return updateCommitmentResponseSchema.parse(result);
  } catch (e) {
    if (e instanceof TaskNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, taskId: e.taskId },
      });
    }
    if (e instanceof CrossPartitionCommitmentError) {
      throw createError({ statusCode: 409, statusMessage: e.message });
    }
    throw e;
  }
});
