import { defineEventHandler, createError } from "h3";
import {
  CrossPartitionCommitmentError,
  setCommitmentDue,
  TaskNotFoundError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  setCommitmentDueRequestSchema,
  setCommitmentDueResponseSchema,
} from "~/lib/schemas/set-commitment-due";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    setCommitmentDueRequestSchema,
    await readBody(event),
  );
  try {
    const result = await setCommitmentDue(
      withRequestAccessScope(event, params),
    );
    return setCommitmentDueResponseSchema.parse(result);
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
