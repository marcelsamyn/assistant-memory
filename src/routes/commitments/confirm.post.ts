import { defineEventHandler, createError } from "h3";
import {
  confirmCommitment,
  CrossPartitionCommitmentError,
  TaskNotFoundError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import {
  commitmentActionRequestSchema,
  confirmCommitmentResponseSchema,
} from "~/lib/schemas/commitment-action";

export default defineEventHandler(async (event) => {
  const params = commitmentActionRequestSchema.parse(await readBody(event));
  try {
    const result = await confirmCommitment(
      withRequestAccessScope(event, params),
    );
    return confirmCommitmentResponseSchema.parse(result);
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
