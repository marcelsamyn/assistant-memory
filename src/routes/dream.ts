import { defineEventHandler, readBody } from "h3";
import { batchQueue, DreamJobData } from "~/lib/queues";
import { dreamRequestSchema, dreamResponseSchema } from "~/lib/schemas/dream";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, assistantId, assistantDescription } =
    dreamRequestSchema.parse(await readBody(event));

  const jobData: DreamJobData = {
    userId,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    assistantId,
    assistantDescription,
  };

  await batchQueue.add("dream", jobData);

  console.log(
    `Enqueued 'dream' job for user ${userId}, assistant ${assistantId}`,
  );

  return dreamResponseSchema.parse({
    message: `Dream job for user ${userId}, assistant ${assistantId} enqueued successfully.`,
  });
});
