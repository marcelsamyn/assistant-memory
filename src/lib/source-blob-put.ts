import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export class SourceBlobUploadTimeoutError extends Error {
  readonly code = "SOURCE_BLOB_UPLOAD_TIMEOUT";

  constructor(timeoutMs: number) {
    super(
      `Source blob upload exceeded ${timeoutMs} ms; storage outcome is unknown`,
    );
    this.name = "SourceBlobUploadTimeoutError";
  }
}

/** Cancels the actual PUT and waits for its local transport to close. */
export async function putSourceBlob(
  signedUrl: string,
  buffer: Buffer,
  timeoutMs: number,
): Promise<void> {
  const url = new URL(signedUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Source blob upload requires HTTP or HTTPS");
  }
  await new Promise<void>((resolve, reject) => {
    let failure: Error | undefined;
    let completed = false;
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "PUT", headers: { "Content-Length": buffer.length } },
      (response) => {
        response.on("error", (error) => {
          failure ??= error;
          request.destroy(error);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            failure ??= new Error(
              `Source blob upload returned HTTP ${response.statusCode}`,
            );
          } else {
            completed = true;
          }
        });
        response.resume();
      },
    );
    const timer = setTimeout(() => {
      failure = new SourceBlobUploadTimeoutError(timeoutMs);
      request.destroy(failure);
    }, timeoutMs);
    request.on("error", (error) => {
      failure ??= error;
    });
    request.on("close", () => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (completed) resolve();
      else
        reject(
          new Error("Source blob upload closed before its response completed"),
        );
    });
    request.end(buffer);
  });
}
