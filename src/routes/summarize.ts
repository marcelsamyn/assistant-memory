import { defineEventHandler, readBody } from "h3";
import { batchQueue, SUMMARIZE_JOB_OPTIONS } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  summarizeRequestSchema,
  summarizeResponseSchema,
} from "~/lib/schemas/summarize";
import {
  assertWorkspaceOperationReady,
  resolveWorkspacePartitions,
} from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey } = parseRequestBody(
    summarizeRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const accessScope = getRequestAccessScope(event);
  const partitions = await resolveWorkspacePartitions(
    db,
    userId,
    partitionKey,
    accessScope,
  );
  await assertWorkspaceOperationReady(db, userId, partitions, accessScope);

  for (const strictPartitionKey of partitions) {
    await batchQueue.add(
      "summarize",
      {
        userId,
        ...(strictPartitionKey !== undefined
          ? { partitionKey: strictPartitionKey }
          : {}),
      },
      SUMMARIZE_JOB_OPTIONS,
    );
  }

  console.log(`Enqueued 'summarize' job for user: ${userId}`);

  return summarizeResponseSchema.parse({
    message: `Summarization job for user ${userId} enqueued successfully.`,
  });
});
