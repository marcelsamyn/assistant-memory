/**
 * Worker for `POST /ingest/document`. The route already created the source
 * row (status `completed`, content stored inline) and queued this job with
 * the resulting `sourceId`. The worker:
 *
 *   1. Loads the inline content back from the source row.
 *   2. Converts HTML → markdown via the markitdown sidecar when the caller
 *      flagged `contentType: "html"`, retaining the original source content
 *      and storing converted Markdown separately for reads/re-extraction.
 *   3. Runs the shared `extractDocumentGraph` pipeline.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { convertToMarkdown } from "~/lib/converters/markitdown";
import { extractDocumentGraph } from "~/lib/ingestion/extract-document-graph";
import { extractEmailAttachment } from "~/lib/ingestion/extract-email-attachment";
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
import {
  contextPartitionKeySchema,
  type ContextPartitionKey,
} from "~/lib/schemas/partition";
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
}: IngestDocumentParams): Promise<
  { partitionKey: ContextPartitionKey | undefined } | undefined
> {
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
    if (processing.status === "completed") return { partitionKey };
    if (processing.status === "failed" || processing.status === "purged")
      return;
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
      metadata.convertedMarkdown ??
      (metadata.convertedToMarkdown === true ? metadata.rawContent : undefined);
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

      // Preserve original HTML and cache Markdown for re-extraction. Merge in
      // SQL so a concurrent metadata write cannot clobber it; the
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
              metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('convertedMarkdown', ${content}::text, 'convertedToMarkdown', true) || ${titleClause}`,
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

    if (
      metadata.sourceContext?.sourceKind === "email_attachment" &&
      contentType !== "html" &&
      metadata.convertedToMarkdown !== true
    ) {
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
              metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('convertedMarkdown', ${content}::text, 'convertedToMarkdown', true)`,
            })
            .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
            .returning({ version: sources.version });
          if (!updated)
            throw new Error("Email attachment disappeared during processing");
          if (operationId !== undefined)
            await advanceSourceIngestionOperationVersion({
              db: tx,
              userId,
              sourceId,
              operationId,
              sourceVersion: updated.version,
            });
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
      if (extraction.status === "completed") return { partitionKey };
      if (extraction.status === "failed" || extraction.status === "purged")
        return;
      extractionStarted = true;
    }

    if (metadata.sourceContext?.sourceKind === "email_attachment") {
      await extractEmailAttachment({
        db,
        userId,
        sourceId,
        expectedSourceVersion: sourceVersion,
        partitionKey,
        context: metadata.sourceContext,
      });
    } else {
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
    }

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
    return { partitionKey };
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
