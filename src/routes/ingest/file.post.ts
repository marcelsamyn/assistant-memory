import { eq } from "drizzle-orm";
import { createError, defineEventHandler, readMultipartFormData } from "h3";
import { v4 as uuid } from "uuid";
import db from "~/db";
import { sources } from "~/db/schema";
import { batchQueue } from "~/lib/queues";
import {
  ingestFileFieldsSchema,
  ingestFileResponseSchema,
  supportedFileMimeTypes,
} from "~/lib/schemas/ingest-file";
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
  });

  if (!isSupportedMime(parsed.mimeType)) {
    throw createError({
      statusCode: 415,
      statusMessage: `unsupported mimeType: ${parsed.mimeType}`,
    });
  }

  const externalId = `file:${uuid()}`;
  const timestamp = parsed.timestamp ?? new Date();

  // Only set `metadata.title` when the user explicitly supplied one.
  // The filename is stored separately under `metadata.filename` so the
  // worker can fill `title` from the converter's derived title (or the
  // listing endpoint can fall back to the filename for display) without
  // either path having to second-guess whether the existing title was
  // explicit or a filename fallback.
  const metadata: Record<string, string> = {
    filename: parsed.filename,
    mimeType: parsed.mimeType,
  };
  if (parsed.title !== undefined) metadata["title"] = parsed.title;
  if (parsed.author !== undefined) metadata["author"] = parsed.author;

  const { successes, failures } = await sourceService.insertMany([
    {
      userId: parsed.userId,
      ...(parsed.partitionKey !== undefined
        ? { partitionKey: parsed.partitionKey }
        : {}),
      sourceType: "document",
      externalId,
      scope: parsed.scope,
      timestamp,
      fileBuffer: filePart.data,
      contentType: parsed.mimeType,
      metadata,
    },
  ]);

  if (failures.length > 0 || successes.length === 0) {
    throw createError({
      statusCode: 500,
      statusMessage: `failed to persist source: ${
        failures[0]?.reason ?? "no row inserted"
      }`,
    });
  }

  const sourceId = successes[0]!;
  const [source] = await db
    .select({ version: sources.version })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  if (!source) throw new Error(`Created source ${sourceId} was not found`);

  await batchQueue.add("ingest-file", {
    userId: parsed.userId,
    partitionKey: parsed.partitionKey,
    sourceId,
    expectedSourceVersion: source.version,
    filename: parsed.filename,
    mimeType: parsed.mimeType,
    timestamp: timestamp.toISOString(),
  });

  return ingestFileResponseSchema.parse({
    message: "File ingestion job accepted",
    jobId: externalId,
    sourceId,
  });
});
