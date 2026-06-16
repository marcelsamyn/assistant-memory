import type { RawResult } from "./sources";

/** Max bytes of a text blob we decode inline in source-detail responses. */
export const TEXT_BLOB_MAX_BYTES = 256 * 1024;

/**
 * Convert a raw source payload into the `content` shape of the detail
 * response. Inline content is always returned; text blobs are decoded up to
 * `TEXT_BLOB_MAX_BYTES`; binary or over-cap blobs return `null` (no inline
 * preview).
 */
export function sourceContentFromRaw(
  raw: RawResult | undefined,
  sourceType: string,
): { text: string; format: "text" | "markdown" } | null {
  if (!raw) return null;
  const format: "text" | "markdown" =
    sourceType === "document" ? "markdown" : "text";
  if (raw.kind === "inline") return { text: raw.content, format };
  if (
    raw.contentType.startsWith("text/") &&
    raw.buffer.length <= TEXT_BLOB_MAX_BYTES
  ) {
    return { text: raw.buffer.toString("utf-8"), format };
  }
  return null;
}
