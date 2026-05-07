/**
 * Thin client for the markitdown HTTP sidecar (services/markitdown).
 *
 * Kept as a single small function so swapping the converter later
 * (different sidecar, in-process libs, hosted API) is a one-file change.
 */
import { env } from "~/utils/env";

export interface ConvertedDocument {
  markdown: string;
  /** Best-effort title extracted by the converter (e.g. PDF metadata). */
  title: string | null;
}

interface ConvertParams {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export async function convertToMarkdown(
  params: ConvertParams,
): Promise<ConvertedDocument> {
  const { buffer, filename, mimeType } = params;

  const form = new FormData();
  // Convert Node Buffer to a Blob so undici's FormData can stream it.
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
  form.append("file", blob, filename);
  form.append("content_type", mimeType);

  const url = `${env.MARKITDOWN_URL.replace(/\/$/, "")}/convert`;
  const response = await fetch(url, { method: "POST", body: form });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? "";
    } catch {
      // ignore JSON parse failures — fall through with the raw status
    }
    throw new Error(
      `markitdown sidecar returned ${response.status} ${response.statusText}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }

  const json = (await response.json()) as {
    markdown?: string;
    title?: string | null;
  };

  return {
    markdown: json.markdown ?? "",
    title: json.title ?? null,
  };
}
