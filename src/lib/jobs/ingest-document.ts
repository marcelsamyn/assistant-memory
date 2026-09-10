/**
 * Worker for `POST /ingest/document`. The route already created the source
 * row (status `completed`, content stored inline) and queued this job with
 * the resulting `sourceId`. The worker:
 *
 *   1. Loads the inline content back from the source row.
 *   2. Converts HTML → markdown via the markitdown sidecar when the caller
 *      flagged `contentType: "html"`, persisting the converted text back
 *      onto `sources.metadata.rawContent` so later reads/re-extractions
 *      see clean markdown.
 *   3. Runs the shared `extractDocumentGraph` pipeline.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { convertToMarkdown } from "~/lib/converters/markitdown";
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

export const IngestDocumentJobInputSchema = z.object({
  userId: z.string(),
  partitionKey: contextPartitionKeySchema.optional(),
  sourceId: typeIdSchema("source"),
  expectedSourceVersion: z.number().int().nonnegative(),
  documentId: z.string(),
  externalId: z.string().optional(),
  operationId: z.string().min(1).optional(),
  /** Supplied by the BullMQ worker; direct callers leave retries recoverable. */
  finalAttempt: z.boolean().optional().default(false),
  contentType: z
    .enum(["markdown", "text", "html"])
    .optional()
    .default("markdown"),
  timestamp: z.string().datetime().pipe(z.coerce.date()),
  author: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

export type IngestDocumentJobInput = z.infer<
  typeof IngestDocumentJobInputSchema
>;

interface IngestDocumentParams extends IngestDocumentJobInput {
  db: DrizzleDB;
}

export async function ingestDocument({
  db,
  userId,
  partitionKey,
  sourceId,
  expectedSourceVersion,
  documentId,
  externalId,
  operationId,
  finalAttempt,
  contentType,
  timestamp,
  author,
  title,
}: IngestDocumentParams): Promise<void> {
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
  if (operationId !== undefined) {
    const processing = await markSourceIngestionProcessing({
      db,
      userId,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      sourceId: sourceId as TypeId<"source">,
      operationId,
      expectedSourceVersion: sourceVersion,
    });
    sourceVersion = processing.sourceVersion;
    if (["completed", "failed", "purged"].includes(processing.status)) return;
  }

  let extractionStarted = false;
  try {
    const [stored] = await db
      .select({ metadata: sources.metadata })
      .from(sources)
      .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)))
      .limit(1);
    const metadata = sourceMetadataSchema.parse(stored?.metadata ?? {});
    const convertedContent =
      metadata.convertedToMarkdown === true ? metadata.rawContent : undefined;
    const text =
      convertedContent ?? (await sourceService.fetchText(userId, sourceId));

    let content = text;
    let resolvedTitle = metadata.title ?? title;

    if (contentType === "html" && convertedContent === undefined) {
      const converted = await convertToMarkdown({
        buffer: Buffer.from(text, "utf-8"),
        filename: `${documentId}.html`,
        mimeType: "text/html",
      });
      content = converted.markdown;
      if (resolvedTitle === undefined && converted.title !== null) {
        resolvedTitle = converted.title;
      }

      // Persist converted markdown (and any newly-derived title) so re-reads
      // surface clean text instead of the original HTML. The merge is computed
      // entirely in SQL so a concurrent metadata write can't clobber it; the
      // CASE on `title` preserves any user-supplied value.
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
              metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('rawContent', ${content}::text, 'convertedToMarkdown', true) || ${titleClause}`,
            })
            .where(
              and(
                eq(sources.id, sourceId as TypeId<"source">),
                eq(sources.userId, userId),
              ),
            )
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

    if (operationId !== undefined) {
      const extraction = await markSourceIngestionExtractionStarted({
        db,
        userId,
        ...(partitionKey !== undefined ? { partitionKey } : {}),
        sourceId: sourceId as TypeId<"source">,
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
      externalId: externalId ?? documentId,
      content,
      timestamp,
      logLabel: resolvedTitle ?? documentId,
      ...(resolvedTitle !== undefined && { title: resolvedTitle }),
      ...(author !== undefined && { author }),
      emailContent: metadata.sourceContext?.sourceKind === "email",
    });

    if (operationId !== undefined) {
      await completeSourceIngestionOperation({
        db,
        userId,
        sourceId: sourceId as TypeId<"source">,
        operationId,
        expectedSourceVersion: sourceVersion,
      });
    }

    console.log(
      `Successfully ingested and processed document ${documentId} for user ${userId}`,
    );
  } catch (error) {
    if (operationId !== undefined && finalAttempt) {
      await failSourceIngestionOperation({
        db,
        userId,
        sourceId: sourceId as TypeId<"source">,
        operationId,
        expectedSourceVersion: sourceVersion,
        errorCode: "EXTRACTION_FAILED",
        stage: extractionStarted ? "extraction" : "content",
      });
    }
    throw error;
  }
}
