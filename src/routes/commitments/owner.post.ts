import { defineEventHandler, createError } from "h3";
import { NodesNotFoundError } from "~/lib/claim";
import {
  CrossPartitionCommitmentError,
  setCommitmentOwner,
  TaskNotFoundError,
} from "~/lib/commitments";
import { withRequestAccessScope } from "~/lib/request-access";
import {
  setCommitmentOwnerRequestSchema,
  setCommitmentOwnerResponseSchema,
} from "~/lib/schemas/set-commitment-owner";

export default defineEventHandler(async (event) => {
  const params = setCommitmentOwnerRequestSchema.parse(await readBody(event));
  try {
    const result = await setCommitmentOwner(
      withRequestAccessScope(event, params),
    );
    return setCommitmentOwnerResponseSchema.parse(result);
  } catch (e) {
    if (e instanceof TaskNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, taskId: e.taskId },
      });
    }
    if (e instanceof NodesNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, missingNodeIds: e.missingNodeIds },
      });
    }
    if (e instanceof CrossPartitionCommitmentError) {
      throw createError({ statusCode: 409, statusMessage: e.message });
    }
    throw e;
  }
});
