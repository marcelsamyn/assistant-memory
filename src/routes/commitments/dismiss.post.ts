import { defineEventHandler, createError } from "h3";
import { dismissCommitment, TaskNotFoundError } from "~/lib/commitments";
import {
  commitmentActionRequestSchema,
  dismissCommitmentResponseSchema,
} from "~/lib/schemas/commitment-action";

export default defineEventHandler(async (event) => {
  const params = commitmentActionRequestSchema.parse(await readBody(event));
  try {
    const result = await dismissCommitment(params);
    return dismissCommitmentResponseSchema.parse(result);
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
