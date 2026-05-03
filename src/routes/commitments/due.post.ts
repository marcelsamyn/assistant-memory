import { defineEventHandler, createError } from "h3";
import { setCommitmentDue, TaskNotFoundError } from "~/lib/commitments";
import {
  setCommitmentDueRequestSchema,
  setCommitmentDueResponseSchema,
} from "~/lib/schemas/set-commitment-due";

export default defineEventHandler(async (event) => {
  const params = setCommitmentDueRequestSchema.parse(await readBody(event));
  try {
    const result = await setCommitmentDue(params);
    return setCommitmentDueResponseSchema.parse(result);
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
