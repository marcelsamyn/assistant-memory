import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { sources } from "~/db/schema";
import { partitionAccessCondition } from "~/lib/partition-access";
import { batchQueue } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import {
  assertWorkspaceOperationReady,
  resolveWorkspacePartitions,
} from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

const requestSchema = z.object({
  userId: z.string().min(1),
  partitionKey: contextPartitionKeySchema.optional(),
  limit: z.number().int().positive().max(5000).default(500),
});

/**
 * Enqueue title generation for the user's existing untitled container sources.
 * Idempotent: the job is a no-op for sources that already have a title, and a
 * deterministic jobId de-dupes concurrent runs.
 */
export default defineEventHandler(async (event) => {
  const { userId, partitionKey, limit } = requestSchema.parse(
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
  let enqueued = 0;
  for (const strictPartitionKey of partitions) {
    const rows = await db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          partitionAccessCondition(
            sources.partitionKey,
            userId,
            strictPartitionKey,
          ),
          inArray(sources.type, [
            "conversation",
            "meeting_transcript",
            "external_conversation",
          ]),
          isNull(sources.deletedAt),
          sql`NOT (COALESCE(${sources.metadata}, '{}'::jsonb) ? 'title')`,
        ),
      )
      .limit(limit - enqueued);

    for (const row of rows) {
      await batchQueue.add(
        "generate-source-title",
        { userId, sourceId: row.id },
        {
          jobId: `source-title:${row.id}`,
          attempts: 2,
          backoff: { type: "exponential", delay: 1_000 },
          removeOnComplete: true,
          removeOnFail: 20,
        },
      );
      enqueued += 1;
    }
    if (enqueued === limit) break;
  }

  return { enqueued };
});
