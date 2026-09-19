import { and, eq, sql } from "drizzle-orm";
import { createError, defineEventHandler, readBody, type H3Event } from "h3";
import db from "~/db";
import { sources, type SourcesSelect } from "~/db/schema";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import {
  ensurePersonalPartition,
  PartitionAccessError,
  assertPartitionReadAllowed,
  preparePartitionWrite,
  withSourceWriteFence,
} from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { batchQueue } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  ingestTranscriptRequestSchema,
  ingestTranscriptResponseSchema,
  type IngestTranscriptResponse,
} from "~/lib/schemas/ingest-transcript";
import { assertWorkspaceOperationReady } from "~/lib/workspace-partitions";

async function ingestTranscript(
  event: H3Event,
): Promise<IngestTranscriptResponse> {
  const body = ingestTranscriptRequestSchema.parse(await readBody(event));

  const accessScope = getRequestAccessScope(event);
  let partitionKey = body.partitionKey;
  let existingSourceId: SourcesSelect["id"] | undefined;

  // Preflight aggregate workspace writes before any source/user mutation or
  // queueing. Existing sources are narrowed to their actual partition below.
  if (accessScope === "workspace") {
    const [existing] = await db
      .select({
        id: sources.id,
        partitionKey: sources.partitionKey,
        deletedAt: sources.deletedAt,
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
    if (existing?.deletedAt !== undefined && existing.deletedAt !== null) {
      throw new PartitionAccessError(
        "SOURCE_TOMBSTONED",
        "Transcript source has been tombstoned",
      );
    }
    existingSourceId = existing?.id;
    const existingPartitionKey = existing?.partitionKey ?? undefined;
    if (
      existing !== undefined &&
      partitionKey !== undefined &&
      partitionKey !== existingPartitionKey
    ) {
      throw new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "Transcript source already belongs to a different memory partition",
      );
    }
    if (existing !== undefined) {
      partitionKey = existingPartitionKey;
    } else {
      partitionKey =
        partitionKey ?? (await ensurePersonalPartition(db, body.userId));
    }
    await assertWorkspaceOperationReady(
      db,
      body.userId,
      [partitionKey],
      accessScope,
    );
    await assertPartitionReadAllowed(db, body.userId, partitionKey);
  }

  await ensureUser(db, body.userId);

  // Pre-create the parent `meeting_transcript` source so the caller gets a
  // sourceId synchronously (matches `/ingest/file` ergonomics and unblocks
  // project auto-attach). The worker's `insertNewSources` upsert is already
  // idempotent for the parent row so re-running is safe.
  await preparePartitionWrite(db, body.userId, partitionKey);
  const parent = await withSourceWriteFence(
    db,
    {
      userId: body.userId,
      sources: existingSourceId ? [{ sourceId: existingSourceId }] : [],
      ...(existingSourceId !== undefined ? { partitionKey } : {}),
      sourceIdentities: [
        {
          userId: body.userId,
          sourceType: "meeting_transcript",
          externalId: body.transcriptId,
        },
      ],
    },
    async (tx) => {
      const now = new Date();
      await tx
        .insert(sources)
        .values({
          userId: body.userId,
          partitionKey,
          type: "meeting_transcript",
          externalId: body.transcriptId,
          scope: body.scope,
          ...(body.sourceKind !== undefined
            ? { metadata: { sourceKind: body.sourceKind } }
            : {}),
          lastIngestedAt: now,
        })
        .onConflictDoNothing({
          target: [sources.userId, sources.type, sources.externalId],
        });
      const [parent] = await tx
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
      if (parent.partitionKey !== (partitionKey ?? null)) {
        throw createError({
          statusCode: 409,
          statusMessage:
            "transcript source already belongs to a different memory partition",
        });
      }
      const [updatedParent] = await tx
        .update(sources)
        .set({
          lastIngestedAt: now,
          ...(body.sourceKind !== undefined
            ? {
                metadata: sql`coalesce(${sources.metadata}, '{}'::jsonb) || ${JSON.stringify({ sourceKind: body.sourceKind })}::jsonb`,
              }
            : {}),
        })
        .where(eq(sources.id, parent.id))
        .returning({ version: sources.version });
      if (!updatedParent)
        throw new Error(`Source ${parent.id} was not updated`);

      return { ...parent, version: updatedParent.version };
    },
  );

  // The job-input schema accepts the same wire shape; revalidating here would
  // be redundant. We forward the parsed body verbatim so the worker can
  // re-parse and apply its own coercions (Date conversion in particular).
  await batchQueue.add("ingest-transcript", {
    ...body,
    partitionKey,
    sourceId: parent.id,
    expectedSourceVersion: parent.version,
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
