import { defineEventHandler, createError } from "h3";
import {
  CrossPartitionCommitmentError,
  setCommitmentStatus,
  TaskNotFoundError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import {
  setCommitmentStatusRequestSchema,
  setCommitmentStatusResponseSchema,
} from "~/lib/schemas/set-commitment-status";

export default defineEventHandler(async (event) => {
  const params = setCommitmentStatusRequestSchema.parse(await readBody(event));
  try {
    const result = await setCommitmentStatus(
      withRequestAccessScope(event, params),
    );
    return setCommitmentStatusResponseSchema.parse(result);
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
