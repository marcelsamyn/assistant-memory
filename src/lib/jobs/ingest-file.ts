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
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { convertToMarkdown } from "~/lib/converters/markitdown";
import { extractGraph } from "~/lib/extract-graph";
import { ensureSourceNode } from "~/lib/ingestion/ensure-source-node";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import { NodeTypeEnum } from "~/types/graph";
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
      metadata: sources.metadata,
      scope: sources.scope,
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

  // Persist the converted markdown alongside the original blob so later
  // reads (e.g. fetchRaw, re-extraction) don't have to re-call the sidecar.
  const existingMeta = sourceMetadataSchema.parse(row.metadata ?? {});
  const updatedMeta = sourceMetadataSchema.parse({
    ...existingMeta,
    rawContent: converted.markdown,
    ...(converted.title !== null &&
      existingMeta.title === undefined && { title: converted.title }),
  });

  await db
    .update(sources)
    .set({ metadata: updatedMeta })
    .where(eq(sources.id, sourceId));

  const documentNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId: sourceId as TypeId<"source">,
    timestamp,
    nodeType: NodeTypeEnum.enum.Document,
  });

  await extractGraph({
    userId,
    sourceType: "document",
    sourceId: sourceId as TypeId<"source">,
    statedAt: timestamp,
    linkedNodeId: documentNodeId,
    sourceRefs: [
      {
        externalId: sourceId,
        sourceId: sourceId as TypeId<"source">,
        statedAt: timestamp,
      },
    ],
    content: converted.markdown,
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
