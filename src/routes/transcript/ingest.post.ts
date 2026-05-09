import { and, eq } from "drizzle-orm";
import { createError } from "h3";
import db from "~/db";
import { sources } from "~/db/schema";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { batchQueue } from "~/lib/queues";
import {
  ingestTranscriptRequestSchema,
  ingestTranscriptResponseSchema,
} from "~/lib/schemas/ingest-transcript";

export default defineEventHandler(async (event) => {
  const body = ingestTranscriptRequestSchema.parse(await readBody(event));

  // Pre-create the parent `meeting_transcript` source so the caller gets a
  // sourceId synchronously (matches `/ingest/file` ergonomics and unblocks
  // project auto-attach). The worker's `insertNewSources` upsert is already
  // idempotent for the parent row so re-running is safe.
  await ensureUser(db, body.userId);
  const now = new Date();
  await db
    .insert(sources)
    .values({
      userId: body.userId,
      type: "meeting_transcript",
      externalId: body.transcriptId,
      scope: body.scope,
      lastIngestedAt: now,
    })
    .onConflictDoUpdate({
      set: { lastIngestedAt: now },
      target: [sources.userId, sources.type, sources.externalId],
    });
  const [parent] = await db
    .select({ id: sources.id })
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

  // The job-input schema accepts the same wire shape; revalidating here would
  // be redundant. We forward the parsed body verbatim so the worker can
  // re-parse and apply its own coercions (Date conversion in particular).
  await batchQueue.add("ingest-transcript", body);

  return ingestTranscriptResponseSchema.parse({
    message: "Transcript ingestion job accepted",
    jobId: body.transcriptId,
    sourceId: parent.id,
  });
});
