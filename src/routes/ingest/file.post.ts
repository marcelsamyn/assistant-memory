import { and, eq, isNull } from "drizzle-orm";
import { createError, defineEventHandler, readMultipartFormData } from "h3";
import { v4 as uuid } from "uuid";
import db from "~/db";
import { sources } from "~/db/schema";
import { contextualFileRevisionExternalId } from "~/lib/ingestion/source-identity";
import {
  createSourceIngestionOperation,
  findSourceIngestionOperation,
  hashSourceContent,
} from "~/lib/ingestion/source-processing";
import { batchQueue } from "~/lib/queues";
import {
  ingestFileFieldsSchema,
  ingestFileResponseSchema,
  supportedFileMimeTypes,
} from "~/lib/schemas/ingest-file";
import type { SourceProcessing } from "~/lib/schemas/source-processing";
import { sourceService } from "~/lib/sources";
import { env } from "~/utils/env";

const SUPPORTED_MIME_SET = new Set<string>(supportedFileMimeTypes);

function isSupportedMime(mime: string): boolean {
  if (SUPPORTED_MIME_SET.has(mime)) return true;
  // Allow any text/* (covers obscure markdown variants without a hardcoded list).
  return mime.startsWith("text/");
}

export default defineEventHandler(async (event) => {
  const parts = await readMultipartFormData(event);
  if (!parts || parts.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "expected multipart/form-data body",
    });
  }

  let filePart: { data: Buffer; filename?: string; type?: string } | undefined;
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.name === "file") {
      filePart = part;
      continue;
    }
    if (part.name) {
      fields[part.name] = part.data.toString("utf-8");
    }
  }

  if (!filePart) {
    throw createError({
      statusCode: 400,
      statusMessage: "missing 'file' part in multipart body",
    });
  }
  if (filePart.data.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: "uploaded file is empty",
    });
  }
  if (filePart.data.length > env.INGEST_FILE_MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `file exceeds INGEST_FILE_MAX_BYTES (${env.INGEST_FILE_MAX_BYTES})`,
    });
  }

  // Multipart filename/content-type live on the file part itself; fall back
  // to explicit fields if the client set them out-of-band.
  const filename = filePart.filename ?? fields["filename"] ?? "";
  const mimeType = fields["mimeType"] ?? filePart.type ?? "";

  const parsed = ingestFileFieldsSchema.parse({
    userId: fields["userId"],
    partitionKey: fields["partitionKey"],
    filename,
    mimeType,
    title: fields["title"],
    author: fields["author"],
    timestamp: fields["timestamp"],
    scope: fields["scope"],
    externalId: fields["externalId"],
    sourceContext: fields["sourceContext"]
      ? JSON.parse(fields["sourceContext"])
      : undefined,
  });

  if (!isSupportedMime(parsed.mimeType)) {
    throw createError({
      statusCode: 415,
      statusMessage: `unsupported mimeType: ${parsed.mimeType}`,
    });
  }

  const contentHash = hashSourceContent(filePart.data);
  const externalId = contextualFileRevisionExternalId({
    externalId: parsed.externalId ?? `file:${uuid()}`,
    ...(parsed.sourceContext !== undefined
      ? {
          accountId: parsed.sourceContext.accountId,
          ...(parsed.partitionKey !== undefined
            ? { partitionKey: parsed.partitionKey }
            : {}),
        }
      : {}),
    contentHash,
  });
  if (
    parsed.sourceContext?.parentPartitionKey !== undefined &&
    parsed.sourceContext.parentPartitionKey !== parsed.partitionKey
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: "source parent does not belong to the requested partition",
    });
  }
  const timestamp = parsed.timestamp ?? new Date();

  // Only set `metadata.title` when the user explicitly supplied one.
  // The filename is stored separately under `metadata.filename` so the
  // worker can fill `title` from the converter's derived title (or the
  // listing endpoint can fall back to the filename for display) without
  // either path having to second-guess whether the existing title was
  // explicit or a filename fallback.
  const metadata: Record<string, unknown> = {
    filename: parsed.filename,
    mimeType: parsed.mimeType,
  };
  if (parsed.title !== undefined) metadata["title"] = parsed.title;
  if (parsed.author !== undefined) metadata["author"] = parsed.author;
  if (parsed.sourceContext !== undefined)
    metadata["sourceContext"] = parsed.sourceContext;

  const { successes, failures } = await sourceService.insertMany([
    {
      userId: parsed.userId,
      ...(parsed.partitionKey !== undefined
        ? { partitionKey: parsed.partitionKey }
        : {}),
      sourceType: "document",
      externalId,
      ...(parsed.sourceContext?.parentSourceId !== undefined
        ? {
            parentId: parsed.sourceContext.parentSourceId,
            ...(parsed.partitionKey !== undefined
              ? { parentPartitionKey: parsed.partitionKey }
              : {}),
          }
        : {}),
      scope: parsed.scope,
      timestamp,
      fileBuffer: filePart.data,
      contentType: parsed.mimeType,
      metadata,
    },
  ]);

  if (failures.length > 0) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to persist source: ${
        failures[0]?.reason ?? "no row inserted"
      }`,
    });
  }

  let sourceId = successes[0];
  let existingProcessing: SourceProcessing | null = null;
  if (!sourceId) {
    const [existing] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.userId, parsed.userId),
          eq(sources.type, "document"),
          eq(sources.externalId, externalId),
          isNull(sources.deletedAt),
          parsed.partitionKey === undefined
            ? isNull(sources.partitionKey)
            : eq(sources.partitionKey, parsed.partitionKey),
        ),
      )
      .limit(1);
    if (!existing) {
      throw createError({
        statusCode: 409,
        statusMessage: "file source is unavailable",
      });
    }
    sourceId = existing.id;
    existingProcessing = await findSourceIngestionOperation({
      db,
      userId: parsed.userId,
      ...(parsed.partitionKey !== undefined
        ? { partitionKey: parsed.partitionKey }
        : {}),
      sourceId,
      contentHash,
    });
    if (!existingProcessing) {
      await sourceService.replaceFileContent({
        userId: parsed.userId,
        sourceId,
        partitionKey: parsed.partitionKey,
        buffer: filePart.data,
        contentType: parsed.mimeType,
        externalId,
        contentHash,
        metadata,
        ...(parsed.sourceContext?.parentSourceId !== undefined
          ? { parentId: parsed.sourceContext.parentSourceId }
          : {}),
        scope: parsed.scope,
        timestamp,
      });
    } else {
      // Repeated bytes reuse their immutable receipt, but caller-owned source
      // metadata can still change without another extraction.
      await sourceService.updateIngestionMetadata({
        userId: parsed.userId,
        sourceId,
        partitionKey: parsed.partitionKey,
        metadata,
        ...(parsed.sourceContext?.parentSourceId !== undefined
          ? { parentId: parsed.sourceContext.parentSourceId }
          : {}),
        scope: parsed.scope,
        timestamp,
      });
    }
  }

  const [source] = await db
    .select({ version: sources.version })
    .from(sources)
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.userId, parsed.userId),
        isNull(sources.deletedAt),
      ),
    )
    .limit(1);
  if (!source) throw new Error(`Created source ${sourceId} was not found`);

  const processing = await createSourceIngestionOperation({
    db,
    userId: parsed.userId,
    ...(parsed.partitionKey !== undefined
      ? { partitionKey: parsed.partitionKey }
      : {}),
    sourceId,
    externalId,
    contentHash,
  });

  if (
    existingProcessing?.status === "completed" ||
    existingProcessing?.status === "failed" ||
    existingProcessing?.status === "purged"
  ) {
    return ingestFileResponseSchema.parse({
      message: "File revision already processed",
      jobId: existingProcessing.operationId,
      sourceId,
      ingestionOperationId: existingProcessing.operationId,
    });
  }

  await batchQueue.add(
    "ingest-file",
    {
      userId: parsed.userId,
      partitionKey: parsed.partitionKey,
      sourceId,
      expectedSourceVersion: processing.sourceVersion,
      filename: parsed.filename,
      mimeType: parsed.mimeType,
      timestamp: timestamp.toISOString(),
      externalId,
      operationId: processing.operationId,
    },
    {
      jobId: processing.operationId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
    },
  );

  return ingestFileResponseSchema.parse({
    message: "File ingestion job accepted",
    jobId: processing.operationId,
    sourceId,
    ingestionOperationId: processing.operationId,
  });
});
