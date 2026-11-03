import route from "./routes/convert/file.post";
import { MemoryClient } from "./sdk/memory-client";
import {
  createApp,
  readMultipartFormData,
  toNodeListener,
  defineEventHandler,
} from "h3";
import { createServer, request as httpRequest, type Server } from "node:http";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { convertToMarkdown } from "~/lib/converters/markitdown";

const config = vi.hoisted(() => {
  // Nitro shares module instances between test files; reload with this suite's env.
  vi.resetModules();
  return {
    MEMORY_API_KEY: "conversion-test-key" as string | undefined,
    INGEST_FILE_MAX_BYTES: 50 * 1024 * 1024,
    MARKITDOWN_URL: "",
  };
});
vi.mock("~/utils/env", () => ({ env: config }));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No HTTP address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function fileForm(
  mimeType = "application/pdf",
  content: BlobPart = "File contents",
  filename = "notes.pdf",
): FormData {
  const form = new FormData();
  form.set("file", new Blob([content], { type: mimeType }), filename);
  return form;
}

describe("POST /convert/file over HTTP", () => {
  let server: Server;
  let sidecar: Server;
  let origin: string;
  let calls: {
    filename: string | undefined;
    mimeType: string | undefined;
    content: string;
  }[];
  let sidecarStatus = 200;
  let sidecarDelay = 0;
  let sidecarResponse: unknown = { markdown: "# Converted", title: "Document" };

  beforeAll(async () => {
    const app = createApp();
    app.use("/convert/file", route);
    server = createServer(toNodeListener(app));
    origin = await listen(server);
    sidecar = createServer(
      toNodeListener(
        createApp().use(
          "/convert",
          defineEventHandler(async (event) => {
            const parts = await readMultipartFormData(event);
            const file = parts?.find((part) => part.name === "file");
            calls.push({
              filename: file?.filename,
              mimeType: file?.type,
              content: file?.data.toString("utf8") ?? "",
            });
            if (sidecarDelay > 0) {
              await new Promise<void>((resolve) =>
                setTimeout(resolve, sidecarDelay),
              );
            }
            event.node.res.statusCode = sidecarStatus;
            return sidecarResponse;
          }),
        ),
      ),
    );
    config.MARKITDOWN_URL = await listen(sidecar);
  });

  afterAll(async () => {
    await close(server);
    await close(sidecar);
    vi.resetModules();
  });
  beforeEach(() => {
    calls = [];
    config.MEMORY_API_KEY = "conversion-test-key";
    config.INGEST_FILE_MAX_BYTES = 50 * 1024 * 1024;
    sidecarStatus = 200;
    sidecarDelay = 0;
    sidecarResponse = { markdown: "# Converted", title: "Document" };
  });

  async function post(
    body: FormData,
    token: string | undefined = config.MEMORY_API_KEY,
  ): Promise<Response> {
    return fetch(`${origin}/convert/file`, {
      method: "POST",
      body,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  it("converts bytes through the sidecar and returns only markdown and title", async () => {
    const response = await post(fileForm());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      markdown: "# Converted",
      title: "Document",
    });
    expect(calls).toEqual([
      {
        filename: "notes.pdf",
        mimeType: "application/pdf",
        content: "File contents",
      },
    ]);
  });

  it("converts through the SDK over real HTTP", async () => {
    const client = new MemoryClient({
      baseUrl: origin,
      apiKey: "conversion-test-key",
    });
    await expect(
      client.convertFile({
        file: Buffer.from("SDK bytes"),
        filename: "document.pdf",
        mimeType: "application/pdf",
      }),
    ).resolves.toEqual({ markdown: "# Converted", title: "Document" });
    expect(calls[0]).toMatchObject({
      filename: "document.pdf",
      mimeType: "application/pdf",
      content: "SDK bytes",
    });
  });

  it("includes the HTTP failure in SDK errors", async () => {
    const client = new MemoryClient({ baseUrl: origin, apiKey: "invalid" });
    await expect(
      client.convertFile({
        file: new Uint8Array([1]),
        filename: "data.txt",
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("401");
    expect(calls).toHaveLength(0);
  });

  it.each(["", "incorrect"])(
    "rejects a missing or incorrect credential before conversion (%s)",
    async (token) => {
      const response = await post(fileForm(), token);
      expect(response.status).toBe(401);
      expect(calls).toHaveLength(0);
    },
  );

  it("fails closed when the credential is not configured", async () => {
    config.MEMORY_API_KEY = undefined;
    expect((await post(fileForm(), "anything")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it.each([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/json",
    "text/javascript",
    "text/csv",
    "text/markdown",
  ])("accepts %s", async (mimeType) => {
    expect((await post(fileForm(mimeType))).status).toBe(200);
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      expect(calls).toHaveLength(0);
    } else {
      expect(calls[0]?.mimeType).toBe(mimeType);
    }
  });

  it.each(["application/json", "text/plain", "text/typescript", "text/csv"])(
    "preserves %s bytes as readable UTF-8",
    async (mimeType) => {
      const content = '  café\n{ "ready": true }\n';
      const response = await post(fileForm(mimeType, content, "data.txt"));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        markdown: content,
        title: null,
      });
      expect(calls).toHaveLength(0);
    },
  );

  it("uses the file part filename for sidecar conversion", async () => {
    const form = fileForm("application/pdf", "document", "actual.pdf");
    form.set("filename", "ignored.pdf");
    expect((await post(form)).status).toBe(200);
    expect(calls[0]?.filename).toBe("actual.pdf");
  });

  it("uses the explicit MIME override", async () => {
    const form = fileForm("application/octet-stream", "{}", "data.json");
    form.set("mimeType", "application/json");
    form.set("filename", "ignored.pdf");
    const response = await post(form);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      markdown: "{}",
      title: null,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { name: "missing file", form: () => new FormData(), status: 400 },
    { name: "empty file", form: () => fileForm("text/plain", ""), status: 400 },
    {
      name: "missing filename",
      form: () => fileForm("text/plain", "hello", ""),
      status: 400,
    },
    {
      name: "unsupported format",
      form: () => fileForm("image/png"),
      status: 415,
    },
    {
      name: "oversized file",
      form: () => fileForm("text/plain", new Uint8Array(10 * 1024 * 1024 + 1)),
      status: 413,
    },
  ])("rejects $name before conversion", async ({ form, status }) => {
    expect((await post(form())).status).toBe(status);
    expect(calls).toHaveLength(0);
  });

  it("rejects a small file with an oversized ignored multipart part", async () => {
    config.INGEST_FILE_MAX_BYTES = 1024;
    const form = fileForm("text/plain", "small");
    form.set("ignored", "x".repeat(1024 + 64 * 1024));
    expect((await post(form)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("rejects oversized chunked multipart requests without Content-Length", async () => {
    config.INGEST_FILE_MAX_BYTES = 1024;
    const boundary = "conversion-boundary";
    const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="tiny.txt"\r\nContent-Type: text/plain\r\n\r\nsmall\r\n--${boundary}\r\nContent-Disposition: form-data; name="ignored"\r\n\r\n`;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/convert/file`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer conversion-test-key",
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      expect(request.hasHeader("content-length")).toBe(false);
      request.write(prefix);
      request.write("x".repeat(1024 + 64 * 1024));
      request.end(`\r\n--${boundary}--\r\n`);
    });
    expect(status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("accepts a file at the configured byte limit with normal multipart overhead", async () => {
    config.INGEST_FILE_MAX_BYTES = 1024;
    const content = "x".repeat(1024);
    const response = await post(fileForm("text/plain", content));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      markdown: content,
      title: null,
    });
  });

  it.each(["text/html; charset=utf-8", " Text/HTML ; charset=UTF-8 "])(
    "converts normalized HTML MIME type %s through the sidecar",
    async (mimeType) => {
      const form = fileForm(
        "application/octet-stream",
        "<h1>Heading</h1>",
        "page.html",
      );
      form.set("mimeType", mimeType);
      const response = await post(form);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        markdown: "# Converted",
        title: "Document",
      });
      expect(calls[0]?.mimeType).toBe("text/html");
    },
  );

  it.each([
    "application/json; charset=utf-8",
    " Application/JSON ; charset=UTF-8 ",
  ])("reads normalized JSON MIME type %s directly", async (mimeType) => {
    const form = fileForm(
      "application/octet-stream",
      '{"ready":true}',
      "data.json",
    );
    form.set("mimeType", mimeType);
    const response = await post(form);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      markdown: '{"ready":true}',
      title: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("passes an explicit deadline through the converter HTTP client", async () => {
    sidecarDelay = 200;
    await expect(
      convertToMarkdown({
        buffer: Buffer.from("document"),
        filename: "document.pdf",
        mimeType: "application/pdf",
        signal: AbortSignal.timeout(25),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls).toHaveLength(1);
  });

  it("rejects oversized converted Markdown", async () => {
    sidecarResponse = {
      markdown: "x".repeat(10 * 1024 * 1024 + 1),
      title: null,
    };
    expect((await post(fileForm())).status).toBe(502);
  });

  it("uses the tighter configured limit", async () => {
    config.INGEST_FILE_MAX_BYTES = 2;
    expect((await post(fileForm())).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("preserves a null title", async () => {
    sidecarResponse = { markdown: "Plain text", title: null };
    await expect((await post(fileForm())).json()).resolves.toEqual(
      sidecarResponse,
    );
  });

  it("reports converter failures", async () => {
    sidecarStatus = 422;
    sidecarResponse = { detail: "Invalid document" };
    expect((await post(fileForm())).status).toBe(502);
  });

  it("rejects an invalid converter response", async () => {
    sidecarResponse = { markdown: 123, title: null };
    expect((await post(fileForm())).status).toBe(502);
  });
});
