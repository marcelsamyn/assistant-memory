import { and, eq } from "drizzle-orm";
import { createError, defineEventHandler, readBody, type H3Event } from "h3";
import db from "~/db";
import { sources } from "~/db/schema";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { preparePartitionWrite } from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { batchQueue } from "~/lib/queues";
import {
  ingestTranscriptRequestSchema,
  ingestTranscriptResponseSchema,
  type IngestTranscriptResponse,
} from "~/lib/schemas/ingest-transcript";

async function ingestTranscript(
  event: H3Event,
): Promise<IngestTranscriptResponse> {
  const body = ingestTranscriptRequestSchema.parse(await readBody(event));

  // Pre-create the parent `meeting_transcript` source so the caller gets a
  // sourceId synchronously (matches `/ingest/file` ergonomics and unblocks
  // project auto-attach). The worker's `insertNewSources` upsert is already
  // idempotent for the parent row so re-running is safe.
  await ensureUser(db, body.userId);
  await preparePartitionWrite(db, body.userId, body.partitionKey);
  const now = new Date();
  await db
    .insert(sources)
    .values({
      userId: body.userId,
      partitionKey: body.partitionKey,
      type: "meeting_transcript",
      externalId: body.transcriptId,
      scope: body.scope,
      lastIngestedAt: now,
    })
    .onConflictDoNothing({
      target: [sources.userId, sources.type, sources.externalId],
    });
  const [parent] = await db
    .select({
      id: sources.id,
      partitionKey: sources.partitionKey,
      version: sources.version,
    })
    .from(sources)
    .where(
      and(
        eq(sources.userId, body.userId),
        eq(sources.type, "meeting_transcript"),
        eq(sources.externalId, body.transcriptId),
      ),
    )
    .limit(1);

  if (!parent) {
    throw createError({
      statusCode: 500,
      statusMessage: "failed to upsert parent transcript source",
    });
  }
  if (parent.partitionKey !== (body.partitionKey ?? null)) {
    throw createError({
      statusCode: 409,
      statusMessage:
        "transcript source already belongs to a different memory partition",
    });
  }
  const [updatedParent] = await db
    .update(sources)
    .set({ lastIngestedAt: now })
    .where(eq(sources.id, parent.id))
    .returning({ version: sources.version });
  if (!updatedParent) throw new Error(`Source ${parent.id} was not updated`);

  // The job-input schema accepts the same wire shape; revalidating here would
  // be redundant. We forward the parsed body verbatim so the worker can
  // re-parse and apply its own coercions (Date conversion in particular).
  await batchQueue.add("ingest-transcript", {
    ...body,
    sourceId: parent.id,
    expectedSourceVersion: updatedParent.version,
  });

  return ingestTranscriptResponseSchema.parse({
    message: "Transcript ingestion job accepted",
    jobId: body.transcriptId,
    sourceId: parent.id,
  });
}

export default defineEventHandler(async (event) => {
  try {
    return await ingestTranscript(event);
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
