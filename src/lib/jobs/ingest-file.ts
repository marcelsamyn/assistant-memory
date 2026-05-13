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
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import { typeIdSchema, type TypeId } from "~/types/typeid";

export const IngestFileJobInputSchema = z.object({
  userId: z.string().min(1),
  sourceId: typeIdSchema("source"),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  timestamp: z.string().datetime().pipe(z.coerce.date()),
});
export type IngestFileJobInput = z.infer<typeof IngestFileJobInputSchema>;

interface IngestFileParams extends IngestFileJobInput {
  db: DrizzleDB;
}

export async function ingestFile({
  db,
  userId,
  sourceId,
  filename,
  mimeType,
  timestamp,
}: IngestFileParams): Promise<void> {
  await ensureUser(db, userId);

  const [row] = await db
    .select({
      id: sources.id,
      externalId: sources.externalId,
      scope: sources.scope,
      metadata: sources.metadata,
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

  await db
    .update(sources)
    .set({ status: "processing" })
    .where(eq(sources.id, sourceId));

  const [raw] = await sourceService.fetchRaw(userId, [
    sourceId as TypeId<"source">,
  ]);
  if (!raw) {
    await markFailed(db, sourceId);
    throw new Error(
      `ingest-file: source ${sourceId} has no payload to convert`,
    );
  }

  // Tiny payloads (<= inline threshold) are persisted as utf-8 strings
  // directly on the source row, so reconstruct a Buffer for the converter.
  const buffer =
    raw.kind === "blob" ? raw.buffer : Buffer.from(raw.content, "utf-8");

  let converted: { markdown: string; title: string | null };
  try {
    converted = await convertToMarkdown({ buffer, filename, mimeType });
  } catch (error) {
    await markFailed(db, sourceId);
    throw error;
  }

  // Persist the converted markdown (and a converter-derived title when
  // the route didn't already set one) alongside the original blob so
  // later reads — fetchRaw, re-extraction — don't re-call the sidecar.
  // The merge is computed entirely in SQL so it is atomic w.r.t. any
  // concurrent metadata write on the same row, and the conditional CASE
  // ensures a user-supplied title is never overwritten by the converter.
  const titleClause =
    converted.title !== null
      ? sql`(CASE WHEN COALESCE(${sources.metadata}, '{}'::jsonb) ? 'title' THEN '{}'::jsonb ELSE jsonb_build_object('title', ${converted.title}::text) END)`
      : sql`'{}'::jsonb`;

  await db
    .update(sources)
    .set({
      metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('rawContent', ${converted.markdown}::text) || ${titleClause}`,
    })
    .where(eq(sources.id, sourceId));

  // Surface the converter-derived title (or filename as fallback) so the LLM
  // knows the content was authored by an external party — without this hint
  // long documents like e-books frequently produce claims attributed to the
  // user (e.g., "the user chose KDP") instead of the document/author.
  const documentTitle = explicitTitle ?? converted.title ?? filename;

  await extractDocumentGraph({
    db,
    userId,
    sourceId: sourceId as TypeId<"source">,
    externalId: row.externalId,
    content: converted.markdown,
    timestamp,
    logLabel: filename,
    title: documentTitle,
    ...(explicitAuthor !== undefined && { author: explicitAuthor }),
  });

  await db
    .update(sources)
    .set({ status: "completed" })
    .where(eq(sources.id, sourceId));
}

async function markFailed(db: DrizzleDB, sourceId: string): Promise<void> {
  try {
    await db
      .update(sources)
      .set({ status: "failed" })
      .where(eq(sources.id, sourceId as TypeId<"source">));
  } catch (err) {
    console.error(
      `ingest-file: failed to mark source ${sourceId} as failed`,
      err,
    );
  }
}
