import { defineEventHandler, readBody } from "h3";
import { batchQueue, DreamJobData } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import { dreamRequestSchema, dreamResponseSchema } from "~/lib/schemas/dream";
import {
  assertWorkspaceOperationReady,
  resolveWorkspacePartitions,
} from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, assistantId, assistantDescription } =
    parseRequestBody(dreamRequestSchema, await readBody(event));

  const accessScope = getRequestAccessScope(event);
  const db = await useDatabase();
  const partitions = await resolveWorkspacePartitions(
    db,
    userId,
    partitionKey,
    accessScope,
  );
  await assertWorkspaceOperationReady(db, userId, partitions, accessScope);
  for (const strictPartitionKey of partitions) {
    const jobData: DreamJobData = {
      userId,
      ...(strictPartitionKey !== undefined
        ? { partitionKey: strictPartitionKey }
        : {}),
      assistantId,
      assistantDescription,
    };
    await batchQueue.add("dream", jobData);
  }

  console.log(
    `Enqueued 'dream' job for user ${userId}, assistant ${assistantId}`,
  );

  return dreamResponseSchema.parse({
    message: `Dream job for user ${userId}, assistant ${assistantId} enqueued successfully.`,
  });
});
