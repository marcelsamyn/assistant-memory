import { defineEventHandler, createError } from "h3";
import { TaskNotFoundError } from "~/lib/commitments";
import { getCommitment } from "~/lib/query/commitment-detail";
import {
  getCommitmentRequestSchema,
  getCommitmentResponseSchema,
} from "~/lib/schemas/get-commitment";

export default defineEventHandler(async (event) => {
  const params = getCommitmentRequestSchema.parse(await readBody(event));
  try {
    const result = await getCommitment(params);
    return getCommitmentResponseSchema.parse(result);
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
