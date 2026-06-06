import { defineEventHandler, createError } from "h3";
import { setCommitmentStatus, TaskNotFoundError } from "~/lib/commitments";
import {
  setCommitmentStatusRequestSchema,
  setCommitmentStatusResponseSchema,
} from "~/lib/schemas/set-commitment-status";

export default defineEventHandler(async (event) => {
  const params = setCommitmentStatusRequestSchema.parse(await readBody(event));
  try {
    const result = await setCommitmentStatus(params);
    return setCommitmentStatusResponseSchema.parse(result);
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
