import { defineEventHandler, createError } from "h3";
import {
  CrossPartitionCommitmentError,
  dismissCommitment,
  TaskNotFoundError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  commitmentActionRequestSchema,
  dismissCommitmentResponseSchema,
} from "~/lib/schemas/commitment-action";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    commitmentActionRequestSchema,
    await readBody(event),
  );
  try {
    const result = await dismissCommitment(
      withRequestAccessScope(event, params),
    );
    return dismissCommitmentResponseSchema.parse(result);
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
