import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  putSourceBlob,
  SourceBlobUploadTimeoutError,
} from "~/lib/source-blob-put";

describe("source blob PUT deadline", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    servers.length = 0;
  });

  async function listen(
    server: ReturnType<typeof createServer>,
  ): Promise<string> {
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    return `http://127.0.0.1:${address.port}/blob`;
  }

  it("destroys a stalled real HTTP request instead of abandoning a pending upload", async () => {
    let close: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const server = createServer((request) => {
      request.socket.once("close", () => close?.());
      request.resume();
    });
    const url = await listen(server);
    await expect(
      putSourceBlob(url, Buffer.from("bytes"), 50),
    ).rejects.toBeInstanceOf(SourceBlobUploadTimeoutError);
    await closed;
  });

  it("awaits a complete successful response", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end());
    });
    await expect(
      putSourceBlob(await listen(server), Buffer.from("bytes"), 1000),
    ).resolves.toBeUndefined();
  });

  it("cancels a response that sends headers but never finishes", async () => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200);
        response.flushHeaders();
      });
    });
    await expect(
      putSourceBlob(await listen(server), Buffer.from("bytes"), 50),
    ).rejects.toBeInstanceOf(SourceBlobUploadTimeoutError);
  });

  it("rejects a storage error response", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(503).end();
    });
    await expect(
      putSourceBlob(await listen(server), Buffer.from("bytes"), 1000),
    ).rejects.toThrow("HTTP 503");
  });
});
