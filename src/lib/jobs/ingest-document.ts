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
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { convertToMarkdown } from "~/lib/converters/markitdown";
import { extractDocumentGraph } from "~/lib/ingestion/extract-document-graph";
import { sourceService } from "~/lib/sources";
import { typeIdSchema, type TypeId } from "~/types/typeid";

export const IngestDocumentJobInputSchema = z.object({
  userId: z.string(),
  sourceId: typeIdSchema("source"),
  documentId: z.string(),
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
  sourceId,
  documentId,
  contentType,
  timestamp,
  author,
  title,
}: IngestDocumentParams): Promise<void> {
  const text = await sourceService.fetchText(userId, sourceId);

  let content = text;
  let resolvedTitle = title;

  if (contentType === "html") {
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
    await db
      .update(sources)
      .set({
        metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('rawContent', ${content}::text) || ${titleClause}`,
      })
      .where(eq(sources.id, sourceId as TypeId<"source">));
  }

  await extractDocumentGraph({
    db,
    userId,
    sourceId: sourceId as TypeId<"source">,
    externalId: documentId,
    content,
    timestamp,
    logLabel: resolvedTitle ?? documentId,
    ...(resolvedTitle !== undefined && { title: resolvedTitle }),
    ...(author !== undefined && { author }),
  });

  console.log(
    `Successfully ingested and processed document ${documentId} for user ${userId}`,
  );
}
