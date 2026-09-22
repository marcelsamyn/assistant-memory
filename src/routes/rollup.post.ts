/**
 * `POST /rollup` — enqueue a temporal-rollup catch-up sweep for a user.
 *
 * Fire-and-forget: the sweep runs as a BullMQ job. A deterministic
 * `rollup:<userId>` jobId collapses concurrent triggers for the same user
 * into one queued sweep. Cost control belongs to the caller: `maxLlmCalls`
 * caps this sweep, `startDate` floors how far back history is summarized.
 */
// `readBody` is deliberately NOT imported: Nitro auto-imports it globally
// (same as src/routes/digest.post.ts), which is what lets the route test
// stub it via vi.stubGlobal.
import { defineEventHandler } from "h3";
import { batchQueue, redisConnection, ROLLUP_JOB_OPTIONS } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  rollupRequestSchema,
  rollupResponseSchema,
} from "~/lib/schemas/rollup";
import {
  assertWorkspaceOperationReady,
  resolveWorkspacePartitions,
} from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(rollupRequestSchema, await readBody(event));
  const db = await useDatabase();
  const accessScope = getRequestAccessScope(event);
  const resolvedPartitions = await resolveWorkspacePartitions(
    db,
    params.userId,
    params.partitionKey,
    accessScope,
  );
  await assertWorkspaceOperationReady(
    db,
    params.userId,
    resolvedPartitions,
    accessScope,
  );
  let partitions = resolvedPartitions;
  if (
    accessScope === "workspace" &&
    params.partitionKey === undefined &&
    partitions.length > 1 &&
    params.maxLlmCalls > 0
  ) {
    const cursor = await redisConnection.incr(
      batchQueue.toKey(`rollup-fair-cursor:${params.userId}`),
    );
    const offset = (cursor - 1) % partitions.length;
    partitions = partitions.map(
      (_, index) => partitions[(index + offset) % partitions.length]!,
    );
  }
  const baseBudget =
    partitions.length === 0
      ? 0
      : Math.floor(params.maxLlmCalls / partitions.length);
  const remainder =
    partitions.length === 0 ? 0 : params.maxLlmCalls % partitions.length;
  let enqueued = false;
  for (const [index, strictPartitionKey] of partitions.entries()) {
    const budget = baseBudget + (index < remainder ? 1 : 0);
    if (budget === 0) continue;
    const jobId =
      strictPartitionKey === undefined
        ? `rollup:${params.userId}`
        : `rollup:${params.userId}:${strictPartitionKey}`;
    const existing = await batchQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === "active" || state === "waiting" || state === "delayed") {
        continue;
      }
      // Completed/failed leftovers block re-use of the deterministic jobId.
      await existing.remove();
    }
    const jobParams = {
      ...params,
      maxLlmCalls: budget,
      ...(strictPartitionKey === undefined
        ? {}
        : { partitionKey: strictPartitionKey }),
    };
    // The getState/remove/add sequence above is not atomic, but BullMQ's add
    // is: a concurrent add with the same jobId is dropped as a duplicate.
    await batchQueue.add("rollup", jobParams, {
      ...ROLLUP_JOB_OPTIONS,
      jobId,
    });
    enqueued = true;
  }
  console.log(`Enqueued 'rollup' job for user: ${params.userId}`);

  return rollupResponseSchema.parse({
    message: `Rollup job for user ${params.userId} enqueued successfully.`,
    enqueued,
  });
});
