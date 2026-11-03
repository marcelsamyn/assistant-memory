import {
  createError,
  defineEventHandler,
  getHeader,
  getRequestWebStream,
  setResponseHeader,
  type H3Event,
} from "h3";
import { createHash, timingSafeEqual } from "node:crypto";
import { convertToMarkdown } from "~/lib/converters/markitdown";
import { parseRequestBody } from "~/lib/request-body";
import {
  convertFileFieldsSchema,
  convertFileMimeTypes,
  convertFileResponseSchema,
  type ConvertFileResponse,
} from "~/lib/schemas/convert-file";
import { env } from "~/utils/env";

function assertAuthorized(event: H3Event): void {
  if (env.MEMORY_API_KEY === undefined) {
    throw createError({
      statusCode: 503,
      statusMessage: "File conversion is unavailable",
    });
  }
  const authorization = getHeader(event, "authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  if (
    supplied === undefined ||
    !timingSafeEqual(
      createHash("sha256").update(supplied).digest(),
      createHash("sha256").update(env.MEMORY_API_KEY).digest(),
    )
  ) {
    throw createError({
      statusCode: 401,
      statusMessage: "Invalid Memory API credential",
    });
  }
}

async function readBoundedMultipart(
  event: H3Event,
  maxBytes: number,
): Promise<FormData> {
  const rejectOversizedBody = (): never => {
    // Pause without cancelling: cancellation can close the socket before 413 arrives.
    event.node.req.pause();
    setResponseHeader(event, "connection", "close");
    throw createError({
      statusCode: 413,
      statusMessage: `multipart body exceeds conversion limit (${maxBytes} bytes)`,
    });
  };
  const contentLength = getHeader(event, "content-length");
  if (contentLength !== undefined && Number(contentLength) > maxBytes) {
    rejectOversizedBody();
  }
  const stream: ReadableStream<Uint8Array> | undefined =
    getRequestWebStream(event);
  const reader = stream?.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) rejectOversizedBody();
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return await new Response(new Uint8Array(Buffer.concat(chunks, size)), {
      headers: { "content-type": getHeader(event, "content-type") ?? "" },
    }).formData();
  } catch (error) {
    throw createError({
      statusCode: 400,
      statusMessage: "expected multipart/form-data body",
      cause: error,
    });
  }
}

export default defineEventHandler(
  async (event): Promise<ConvertFileResponse> => {
    assertAuthorized(event);
    const maxBytes = Math.min(10 * 1024 * 1024, env.INGEST_FILE_MAX_BYTES);
    const form = await readBoundedMultipart(event, maxBytes + 64 * 1024);
    const file = form.get("file");
    if (file === null || typeof file === "string") {
      throw createError({
        statusCode: 400,
        statusMessage: "missing 'file' part in multipart body",
      });
    }
    if (file.size === 0) {
      throw createError({
        statusCode: 400,
        statusMessage: "uploaded file is empty",
      });
    }
    if (file.size > maxBytes) {
      throw createError({
        statusCode: 413,
        statusMessage: `file exceeds conversion limit (${maxBytes} bytes)`,
      });
    }
    const fields = parseRequestBody(convertFileFieldsSchema, {
      filename: file.name,
      mimeType: form.get("mimeType") ?? file.type,
    });
    if (
      !fields.mimeType.startsWith("text/") &&
      !convertFileMimeTypes.some((mimeType) => mimeType === fields.mimeType)
    ) {
      throw createError({
        statusCode: 415,
        statusMessage: `unsupported mimeType: ${fields.mimeType}`,
      });
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    // Plain text formats already contain the complete readable document.
    if (
      fields.mimeType === "application/json" ||
      (fields.mimeType.startsWith("text/") &&
        fields.mimeType !== "text/html" &&
        fields.mimeType !== "text/rtf")
    ) {
      return { markdown: buffer.toString("utf8"), title: null };
    }
    try {
      const result = await convertToMarkdown({
        buffer,
        ...fields,
        signal: AbortSignal.timeout(120_000),
      });
      return convertFileResponseSchema.parse(result);
    } catch (error) {
      throw createError({
        statusCode: 502,
        statusMessage: "File conversion failed",
        cause: error,
      });
    }
  },
);
