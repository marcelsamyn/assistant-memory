import { and, eq, isNull } from "drizzle-orm";
import {
  createError,
  defineEventHandler,
  readMultipartFormData,
  type H3Event,
} from "h3";
import { v4 as uuid } from "uuid";
import db from "~/db";
import { sources } from "~/db/schema";
import { updateDocumentTitle } from "~/lib/ingestion/apply-document-spine";
import { contextualFileRevisionExternalId } from "~/lib/ingestion/source-identity";
import {
  createSourceIngestionOperation,
  findSourceIngestionOperation,
  hashSourceContent,
} from "~/lib/ingestion/source-processing";
import {
  ensurePersonalPartition,
  PartitionAccessError,
} from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { batchQueue } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  ingestFileFieldsSchema,
  ingestFileResponseSchema,
  supportedFileMimeTypes,
  type IngestFileResponse,
} from "~/lib/schemas/ingest-file";
import type { SourceProcessing } from "~/lib/schemas/source-processing";
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import { assertWorkspaceOperationReady } from "~/lib/workspace-partitions";
import { env } from "~/utils/env";

const SUPPORTED_MIME_SET = new Set<string>(supportedFileMimeTypes);

function isSupportedMime(mime: string): boolean {
  if (SUPPORTED_MIME_SET.has(mime)) return true;
  // Allow any text/* (covers obscure markdown variants without a hardcoded list).
  return mime.startsWith("text/");
}

async function ingestFile(event: H3Event): Promise<IngestFileResponse> {
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
  const accessScope = getRequestAccessScope(event);
  let partitionKey = parsed.partitionKey;
  if (accessScope === "workspace") {
    if (parsed.sourceContext?.parentSourceId !== undefined) {
      const [parent] = await db
        .select({ partitionKey: sources.partitionKey })
        .from(sources)
        .where(
          and(
            eq(sources.userId, parsed.userId),
            eq(sources.id, parsed.sourceContext.parentSourceId),
            isNull(sources.deletedAt),
          ),
        )
        .limit(1);
      if (!parent) {
        throw new PartitionAccessError(
          "PARTITION_UNAUTHORIZED",
          "Source parent does not exist in the requested workspace",
        );
      }
      const parentPartitionKey = parent.partitionKey ?? undefined;
      if (
        (partitionKey !== undefined && partitionKey !== parentPartitionKey) ||
        (parsed.sourceContext.parentPartitionKey !== undefined &&
          parsed.sourceContext.parentPartitionKey !== parentPartitionKey)
      ) {
        throw new PartitionAccessError(
          "PARTITION_UNAUTHORIZED",
          "Source parent does not belong to the requested partition",
        );
      }
      partitionKey = parentPartitionKey;
    } else if (partitionKey === undefined) {
      partitionKey = await ensurePersonalPartition(db, parsed.userId);
    }
  }

  if (!isSupportedMime(parsed.mimeType)) {
    throw createError({
      statusCode: 415,
      statusMessage: `unsupported mimeType: ${parsed.mimeType}`,
    });
  }

  const contentHash = hashSourceContent(filePart.data);
  if (
    accessScope === "workspace" &&
    parsed.partitionKey === undefined &&
    parsed.sourceContext === undefined &&
    parsed.externalId !== undefined
  ) {
    const existingExternalId = contextualFileRevisionExternalId({
      externalId: parsed.externalId,
      contentHash,
    });
    const [existing] = await db
      .select({ partitionKey: sources.partitionKey })
      .from(sources)
      .where(
        and(
          eq(sources.userId, parsed.userId),
          eq(sources.type, "document"),
          eq(sources.externalId, existingExternalId),
          isNull(sources.deletedAt),
        ),
      )
      .limit(1);
    if (existing) partitionKey = existing.partitionKey ?? undefined;
  }
  await assertWorkspaceOperationReady(
    db,
    parsed.userId,
    [partitionKey],
    accessScope,
  );
  const externalId = contextualFileRevisionExternalId({
    externalId: parsed.externalId ?? `file:${uuid()}`,
    ...(parsed.sourceContext !== undefined
      ? {
          accountId: parsed.sourceContext.accountId,
          ...(partitionKey !== undefined ? { partitionKey } : {}),
        }
      : {}),
    contentHash,
  });
  if (
    parsed.sourceContext?.parentPartitionKey !== undefined &&
    parsed.sourceContext.parentPartitionKey !== partitionKey
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: "source parent does not belong to the requested partition",
    });
  }
  // Only set `metadata.title` when the user explicitly supplied one.
  // The filename is stored separately under `metadata.filename` so the
  // worker can fill `title` from the converter's derived title (or the
  // listing endpoint can fall back to the filename for display) without
  // either path having to second-guess whether the existing title was
  // explicit or a filename fallback.
  const inputMetadata = {
    filename: parsed.filename,
    mimeType: parsed.mimeType,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
    ...(parsed.author === undefined ? {} : { author: parsed.author }),
    ...(parsed.sourceContext === undefined
      ? {}
      : { sourceContext: parsed.sourceContext }),
  };

  const { successes, failures, timestamp, metadata, revisionHash } =
    await sourceService.insertIngestionSource({
      userId: parsed.userId,
      accessScope,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      sourceType: "document",
      externalId,
      ...(parsed.sourceContext?.parentSourceId !== undefined
        ? {
            parentId: parsed.sourceContext.parentSourceId,
            ...(partitionKey !== undefined
              ? { parentPartitionKey: partitionKey }
              : {}),
          }
        : {}),
      scope: parsed.scope,
      timestamp: parsed.timestamp,
      extractionContentHash: contentHash,
      extractionContentType: parsed.mimeType,
      fileBuffer: filePart.data,
      contentType: parsed.mimeType,
      metadata: inputMetadata,
    });

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
      .select({
        id: sources.id,
        metadata: sources.metadata,
        contentLength: sources.contentLength,
      })
      .from(sources)
      .where(
        and(
          eq(sources.userId, parsed.userId),
          eq(sources.type, "document"),
          eq(sources.externalId, externalId),
          isNull(sources.deletedAt),
          partitionKey === undefined
            ? isNull(sources.partitionKey)
            : eq(sources.partitionKey, partitionKey),
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
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      sourceId,
      contentHash: revisionHash,
    });
    const storedMetadata = sourceMetadataSchema.parse(existing.metadata);
    const samePersistedRevision =
      storedMetadata.ingestionRevisionHash === revisionHash &&
      (typeof storedMetadata.rawContent === "string" ||
        existing.contentLength !== null);
    if (!existingProcessing && !samePersistedRevision) {
      await sourceService.replaceFileContent({
        userId: parsed.userId,
        sourceId,
        partitionKey,
        accessScope,
        buffer: filePart.data,
        contentType: parsed.mimeType,
        externalId,
        contentHash: revisionHash,
        metadata,
        ...(parsed.sourceContext?.parentSourceId !== undefined
          ? { parentId: parsed.sourceContext.parentSourceId }
          : {}),
        scope: parsed.scope,
        timestamp,
      });
    } else if (existingProcessing) {
      // Repeated bytes reuse their immutable receipt, but caller-owned source
      // metadata can still change without another extraction.
      const updatedVersion = await sourceService.updateIngestionMetadata({
        userId: parsed.userId,
        sourceId,
        partitionKey,
        accessScope,
        metadata,
        ...(parsed.sourceContext?.parentSourceId !== undefined
          ? { parentId: parsed.sourceContext.parentSourceId }
          : {}),
        scope: parsed.scope,
        timestamp,
      });
      if (parsed.title !== undefined || storedMetadata.title === undefined) {
        await updateDocumentTitle({
          db,
          userId: parsed.userId,
          sourceId,
          expectedSourceVersion: updatedVersion,
          title: parsed.title ?? parsed.filename,
        });
      }
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
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    sourceId,
    externalId,
    contentHash: revisionHash,
    expectedSourceVersion: source.version,
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
      partitionKey,
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
}

export default defineEventHandler(async (event) => {
  try {
    return await ingestFile(event);
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
