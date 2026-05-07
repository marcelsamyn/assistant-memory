/**
 * Schema for `POST /ingest/file` and the `ingestFile` SDK method.
 *
 * The request is sent as `multipart/form-data` (so binary bytes can stream
 * straight through). The schema below validates the *parsed* form fields
 * once they've been pulled out of the multipart body — the `file` part is
 * out-of-band.
 *
 * Conversion to text/markdown happens server-side in the ingest-file
 * worker (currently via the markitdown sidecar) so every client gets the
 * same parsing behavior.
 */
import { z } from "zod";
import { ScopeEnum } from "../../types/graph.js";
import { typeIdSchema } from "../../types/typeid.js";

/**
 * MIME types accepted at v1. The list intentionally favors the formats
 * called out in the design doc; expanding it is a one-line change as the
 * markitdown sidecar already handles a much wider set.
 */
export const supportedFileMimeTypes = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/msword", // legacy .doc — markitdown handles it best-effort
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/markdown",
  "text/html",
] as const;
export type SupportedFileMimeType = (typeof supportedFileMimeTypes)[number];

/**
 * Validation for the parsed multipart form fields. The `file` blob is
 * carried separately at the route layer and is not part of this schema.
 */
export const ingestFileFieldsSchema = z.object({
  userId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  title: z.string().min(1).optional(),
  scope: ScopeEnum.optional().default("personal"),
});
export type IngestFileFields = z.infer<typeof ingestFileFieldsSchema>;

export const ingestFileResponseSchema = z.object({
  message: z.string(),
  jobId: z.string(),
  sourceId: typeIdSchema("source"),
});
export type IngestFileResponse = z.infer<typeof ingestFileResponseSchema>;

/**
 * SDK-level request shape — the `MemoryClient.ingestFile` method takes
 * this and assembles a multipart/form-data body. `file` is intentionally
 * loose-typed because it spans Node `Buffer`, browser `Blob`, and
 * `Uint8Array` callers.
 */
export interface IngestFileRequest {
  userId: string;
  file: Buffer | Blob | Uint8Array;
  filename: string;
  mimeType: string;
  title?: string;
  scope?: "personal" | "reference";
}
