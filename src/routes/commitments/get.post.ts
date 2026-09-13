import { defineEventHandler, createError } from "h3";
import { TaskNotFoundError } from "~/lib/commitments";
import { resolveNodePartition } from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { getCommitment } from "~/lib/query/commitment-detail";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  getCommitmentRequestSchema,
  getCommitmentResponseSchema,
} from "~/lib/schemas/get-commitment";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = getCommitmentRequestSchema.parse(await readBody(event));
  try {
    const accessScope = getRequestAccessScope(event);
    const db = await useDatabase();
    const partitionKey = await resolveNodePartition(
      db,
      params.userId,
      params.taskId,
      params.partitionKey,
      accessScope,
    );
    const result = await getCommitment({ ...params, partitionKey });
    return getCommitmentResponseSchema.parse(result);
  } catch (e) {
    if (e instanceof TaskNotFoundError) {
      throw createError({
        statusCode: 404,
        statusMessage: e.message,
        data: { name: e.name, taskId: e.taskId },
      });
    }
    throwPartitionRouteError(e);
  }
});
