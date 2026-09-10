/**
 * Worker for `POST /ingest/file`. The route already wrote the source row
 * (status `pending`) and uploaded the bytes to MinIO; the worker pulls
 * those bytes back, converts them to Markdown via the markitdown sidecar,
 * stores the converted text on `sources.metadata.rawContent`, and runs
 * the existing graph-extraction pipeline against it.
 *
 * Failure modes:
 *  - missing source row / blob → mark source `failed`, exit
 *  - markitdown error          → mark source `failed`, propagate so BullMQ
 *                                retries per its policy
 *  - extractor error           → propagate (source row stays `processing`
 *                                so a retry can resume cleanly)
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { convertToMarkdown } from "~/lib/converters/markitdown";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { extractDocumentGraph } from "~/lib/ingestion/extract-document-graph";
import {
  completeSourceIngestionOperation,
  advanceSourceIngestionOperationVersion,
  failSourceIngestionOperation,
  markSourceIngestionExtractionStarted,
  markSourceIngestionProcessing,
  getSourceIngestionJobContext,
} from "~/lib/ingestion/source-processing";
import {
  assertSourcePartition,
  withSourceWriteFence,
} from "~/lib/partition-access";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import { typeIdSchema, type TypeId } from "~/types/typeid";

export const IngestFileJobInputSchema = z.object({
  userId: z.string().min(1),
  partitionKey: contextPartitionKeySchema.optional(),
  sourceId: typeIdSchema("source"),
  expectedSourceVersion: z.number().int().nonnegative(),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  timestamp: z.string().datetime().pipe(z.coerce.date()),
  externalId: z.string().optional(),
  operationId: z.string().min(1).optional(),
  /** Supplied by the BullMQ worker; direct callers leave retries recoverable. */
  finalAttempt: z.boolean().optional().default(false),
});
export type IngestFileJobInput = z.infer<typeof IngestFileJobInputSchema>;

interface IngestFileParams extends IngestFileJobInput {
  db: DrizzleDB;
}

export async function ingestFile({
  db,
  userId,
  partitionKey,
  sourceId,
  expectedSourceVersion,
  filename,
  mimeType,
  timestamp,
  externalId,
  operationId,
  finalAttempt,
}: IngestFileParams): Promise<void> {
  await ensureUser(db, userId);
  if (operationId !== undefined) {
    const context = await getSourceIngestionJobContext({
      db,
      userId,
      sourceId,
      operationId,
    });
    partitionKey = context.partitionKey;
    externalId = context.externalId;
  }
  await assertSourcePartition({
    db,
    userId,
    sourceId,
    partitionKey,
    ...(operationId === undefined ? { expectedSourceVersion } : {}),
  });
  let sourceVersion = expectedSourceVersion;

  const [row] = await db
    .select({
      id: sources.id,
      externalId: sources.externalId,
      scope: sources.scope,
      metadata: sources.metadata,
      contentType: sources.contentType,
    })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1);

  if (!row) {
    console.warn(
      `ingest-file: source ${sourceId} for user ${userId} not found, skipping`,
    );
    return;
  }

  // Snapshot the explicit user-supplied bibliographic fields before the
  // converter merge below — `author` is set only by the route, and `title`
  // here represents the explicit user title (the converter writes its
  // fallback into `title` only when this slot is empty, which we honor).
  const existingMeta = sourceMetadataSchema.parse(row.metadata ?? {});
  const explicitAuthor = existingMeta.author;
  const explicitTitle = existingMeta.title;

  if (operationId !== undefined) {
    const processing = await markSourceIngestionProcessing({
      db,
      userId,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      sourceId,
      operationId,
      expectedSourceVersion: sourceVersion,
    });
    sourceVersion = processing.sourceVersion;
    if (["completed", "failed", "purged"].includes(processing.status)) return;
  } else {
    sourceVersion = await updateSourceWhileLive({
      db,
      userId,
      sourceId,
      expectedSourceVersion: sourceVersion,
      set: { status: "processing" },
    });
  }

  let extractionStarted = false;
  try {
    // Original non-text bytes live only in blob storage. A binary contentType
    // plus rawContent therefore identifies a converted file from before the
    // explicit marker existed; original inline text has no contentType.
    const hasConvertedContent =
      existingMeta.rawContent !== undefined &&
      (existingMeta.convertedToMarkdown === true ||
        (row.contentType !== null && !row.contentType.startsWith("text/")));
    let converted: { markdown: string; title: string | null };
    if (hasConvertedContent && existingMeta.rawContent !== undefined) {
      converted = {
        markdown: existingMeta.rawContent,
        title: explicitTitle ?? null,
      };
    } else {
      const [raw] = await sourceService.fetchRaw(userId, [
        sourceId as TypeId<"source">,
      ]);
      if (!raw) {
        throw new Error(
          `ingest-file: source ${sourceId} has no payload to convert`,
        );
      }

      // Tiny payloads (<= inline threshold) are persisted as utf-8 strings
      // directly on the source row, so reconstruct a Buffer for the converter.
      const buffer =
        raw.kind === "blob" ? raw.buffer : Buffer.from(raw.content, "utf-8");

      converted = await convertToMarkdown({ buffer, filename, mimeType });
    }
    if (converted.markdown.trim().length === 0) {
      if (operationId !== undefined) {
        await failSourceIngestionOperation({
          db,
          userId,
          sourceId,
          operationId,
          expectedSourceVersion: sourceVersion,
          errorCode: "UNREADABLE_CONTENT",
          stage: "content",
        });
      } else {
        await updateSourceWhileLive({
          db,
          userId,
          sourceId,
          expectedSourceVersion: sourceVersion,
          set: { status: "failed" },
        });
      }
      return;
    }

    // Persist the converted markdown (and a converter-derived title when
    // the route didn't already set one) alongside the original blob so
    // later reads — fetchRaw, re-extraction — don't re-call the sidecar.
    // The merge is computed entirely in SQL so it is atomic w.r.t. any
    // concurrent metadata write on the same row, and the conditional CASE
    // ensures a user-supplied title is never overwritten by the converter.
    if (!hasConvertedContent) {
      const titleClause =
        converted.title !== null
          ? sql`(CASE WHEN COALESCE(${sources.metadata}, '{}'::jsonb) ? 'title' THEN '{}'::jsonb ELSE jsonb_build_object('title', ${converted.title}::text) END)`
          : sql`'{}'::jsonb`;

      sourceVersion = await withSourceWriteFence(
        db,
        {
          userId,
          sources: [{ sourceId, expectedSourceVersion: sourceVersion }],
        },
        async (tx) => {
          const [updated] = await tx
            .update(sources)
            .set({
              metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('rawContent', ${converted.markdown}::text, 'convertedToMarkdown', true) || ${titleClause}`,
            })
            .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
            .returning({ version: sources.version });
          if (!updated)
            throw new Error(`Source ${sourceId} disappeared during conversion`);
          if (operationId !== undefined) {
            await advanceSourceIngestionOperationVersion({
              db: tx,
              userId,
              sourceId,
              operationId,
              sourceVersion: updated.version,
            });
          }
          return updated.version;
        },
      );
    }

    // Surface the converter-derived title (or filename as fallback) so the LLM
    // knows the content was authored by an external party — without this hint
    // long documents like e-books frequently produce claims attributed to the
    // user (e.g., "the user chose KDP") instead of the document/author.
    const documentTitle = explicitTitle ?? converted.title ?? filename;

    if (operationId !== undefined) {
      const extraction = await markSourceIngestionExtractionStarted({
        db,
        userId,
        ...(partitionKey !== undefined ? { partitionKey } : {}),
        sourceId,
        operationId,
      });
      if (["completed", "failed", "purged"].includes(extraction.status)) return;
      extractionStarted = true;
    }

    await extractDocumentGraph({
      db,
      userId,
      sourceId: sourceId as TypeId<"source">,
      expectedSourceVersion: sourceVersion,
      externalId: externalId ?? row.externalId,
      content: converted.markdown,
      timestamp,
      logLabel: filename,
      title: documentTitle,
      ...(explicitAuthor !== undefined && { author: explicitAuthor }),
    });

    if (operationId !== undefined) {
      await completeSourceIngestionOperation({
        db,
        userId,
        sourceId,
        operationId,
        expectedSourceVersion: sourceVersion,
      });
    } else {
      await updateSourceWhileLive({
        db,
        userId,
        sourceId,
        expectedSourceVersion: sourceVersion,
        set: { status: "completed" },
      });
    }
  } catch (error) {
    if (operationId !== undefined && finalAttempt) {
      await failSourceIngestionOperation({
        db,
        userId,
        sourceId,
        operationId,
        expectedSourceVersion: sourceVersion,
        errorCode: "EXTRACTION_FAILED",
        stage: extractionStarted ? "extraction" : "content",
      });
    } else if (operationId === undefined) {
      await markFailed(db, userId, sourceId, sourceVersion);
    }
    throw error;
  }
}

async function updateSourceWhileLive({
  db,
  userId,
  sourceId,
  expectedSourceVersion,
  set,
}: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  expectedSourceVersion: number;
  set: Pick<typeof sources.$inferInsert, "status">;
}): Promise<number> {
  return withSourceWriteFence(
    db,
    { userId, sources: [{ sourceId, expectedSourceVersion }] },
    async (tx) => {
      const [updated] = await tx
        .update(sources)
        .set(set)
        .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
        .returning({ version: sources.version });
      if (!updated)
        throw new Error(`Source ${sourceId} disappeared during ingestion`);
      return updated.version;
    },
  );
}

async function markFailed(
  db: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
  expectedSourceVersion: number,
): Promise<void> {
  try {
    await updateSourceWhileLive({
      db,
      userId,
      sourceId,
      expectedSourceVersion,
      set: { status: "failed" },
    });
  } catch (err) {
    console.error(
      `ingest-file: failed to mark source ${sourceId} as failed`,
      err,
    );
  }
}
