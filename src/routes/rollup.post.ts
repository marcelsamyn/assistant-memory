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
import { batchQueue, ROLLUP_JOB_OPTIONS } from "~/lib/queues";
import {
  rollupRequestSchema,
  rollupResponseSchema,
} from "~/lib/schemas/rollup";

export default defineEventHandler(async (event) => {
  const params = rollupRequestSchema.parse(await readBody(event));
  const jobId = `rollup:${params.userId}`;

  const existing = await batchQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "active" || state === "waiting" || state === "delayed") {
      return rollupResponseSchema.parse({
        message: `Rollup already queued for user ${params.userId}.`,
        enqueued: false,
      });
    }
    // Completed/failed leftovers block re-use of the deterministic jobId.
    await existing.remove();
  }

  // The getState/remove/add sequence above is not atomic, but BullMQ's add
  // is: a concurrent add with the same jobId is dropped as a duplicate.
  await batchQueue.add("rollup", params, { ...ROLLUP_JOB_OPTIONS, jobId });
  console.log(`Enqueued 'rollup' job for user: ${params.userId}`);

  return rollupResponseSchema.parse({
    message: `Rollup job for user ${params.userId} enqueued successfully.`,
    enqueued: true,
  });
});
