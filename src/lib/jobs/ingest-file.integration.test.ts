import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client as MinioClient } from "minio";
import { Readable } from "node:stream";
import { Client } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "~/db/schema";
import { sources, users } from "~/db/schema";
import {
  createSourceIngestionOperation,
  getSourceIngestionOperationById,
  hashSourceContent,
  retrySourceIngestionOperation,
} from "~/lib/ingestion/source-processing";
import { withSourceWriteFence } from "~/lib/partition-access";
import {
  reclassifySourcePartition,
  setPartitionMigrationState,
} from "~/lib/partition-reclassification";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { SourceService } from "~/lib/sources";

vi.hoisted(() => {
  process.env["DATABASE_URL"] ??=
    "postgres://postgres:postgres@localhost:5431/postgres";
  process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
  process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
  process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
  process.env["JINA_API_KEY"] ??= "test";
  process.env["REDIS_URL"] ??= "redis://localhost:6380";
  process.env["MINIO_ENDPOINT"] ??= "localhost";
  process.env["MINIO_ACCESS_KEY"] ??= "minio";
  process.env["MINIO_SECRET_KEY"] ??= "minio123";
  process.env["SOURCES_BUCKET"] ??= "ingest-file-unreadable-test";
});

const host = process.env["TEST_PG_HOST"] ?? "localhost";
const port = Number(process.env["TEST_PG_PORT"] ?? 5431);
const user = process.env["TEST_PG_USER"] ?? "postgres";
const password = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const adminDatabase = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";
const dsnFor = (name: string): string =>
  `postgres://${user}:${password}@${host}:${port}/${name}`;
async function isPostgresReachable(): Promise<boolean> {
  const client = new Client({ connectionString: dsnFor(adminDatabase) });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}
const describeIfPostgres = (await isPostgresReachable())
  ? describe
  : describe.skip;

describeIfPostgres("unreadable file conversion", () => {
  const dbName = `memory_unreadable_file_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;
  let database: NodePgDatabase<typeof schema>;
  let ingestFile: (typeof import("./ingest-file"))["ingestFile"];
  let ingestDocument: (typeof import("./ingest-document"))["ingestDocument"];
  let service: SourceService;
  let getSource: (typeof import("~/lib/get-source"))["getSource"];
  let blobClient: MinioClient;
  const convertToMarkdown = vi.fn();
  const extractDocumentGraph = vi.fn();
  const originalContent = "Original attachment payload";

  beforeEach(() => {
    convertToMarkdown.mockReset();
    extractDocumentGraph.mockReset();
  });

  beforeAll(async () => {
    // Other integration suites exercise the real worker before this suite
    // installs its conversion and extraction boundary mocks.
    vi.resetModules();
    const admin = new Client({ connectionString: dsnFor(adminDatabase) });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    blobClient = new MinioClient({
      endPoint: "localhost",
      port: 9000,
      useSSL: false,
      accessKey: "unused",
      secretKey: "unused",
    });
    service = new SourceService(database, blobClient, "unused");
    vi.doMock("~/lib/sources", async () => ({
      ...(await vi.importActual<typeof import("~/lib/sources")>(
        "~/lib/sources",
      )),
      sourceService: service,
    }));
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    ({ getSource } = await import("~/lib/get-source"));
    vi.doMock("~/lib/converters/markitdown", () => ({ convertToMarkdown }));
    vi.doMock("~/lib/ingestion/extract-document-graph", () => ({
      extractDocumentGraph,
    }));
    ({ ingestFile } = await import("./ingest-file"));
    ({ ingestDocument } = await import("./ingest-document"));
  }, 120_000);

  afterAll(async () => {
    vi.doUnmock("~/utils/db");
    vi.doUnmock("~/lib/sources");
    vi.doUnmock("~/lib/converters/markitdown");
    vi.doUnmock("~/lib/ingestion/extract-document-graph");
    vi.resetModules();
    await client.end();
    const admin = new Client({ connectionString: dsnFor(adminDatabase) });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it.each(["document", "file"] as const)(
    "returns the current partition after a retained %s job moves",
    async (kind) => {
      const userId = `moved-${kind}-job`;
      const partitionKey = contextPartitionKeySchema.parse(`moved:${kind}`);
      await database.insert(users).values({ id: userId });
      const [source] = await database
        .insert(sources)
        .values({
          userId,
          type: "document",
          externalId: `${kind}-before-move`,
          metadata: { rawContent: "Current text", convertedToMarkdown: true },
          status: "pending",
        })
        .returning();
      if (!source) throw new Error("Source missing");
      const operation = await createSourceIngestionOperation({
        db: database,
        userId,
        sourceId: source.id,
        externalId: source.externalId,
        contentHash: hashSourceContent("Current text"),
      });
      await setPartitionMigrationState(database, {
        userId,
        expectedState: "unmigrated",
        expectedVersion: 0,
        nextState: "migrating",
      });
      await reclassifySourcePartition(database, {
        userId,
        sourceId: source.id,
        expectedPartitionKey: null,
        expectedSourceVersion: operation.sourceVersion,
        targetPartitionKey: partitionKey,
        bindingGeneration: "retained-job-move",
      });
      await setPartitionMigrationState(database, {
        userId,
        expectedState: "migrating",
        expectedVersion: 1,
        nextState: "migrated",
        unassignedPartitionKey: partitionKey,
      });
      const common = {
        db: database,
        userId,
        sourceId: source.id,
        operationId: operation.operationId,
        expectedSourceVersion: operation.sourceVersion,
        timestamp: new Date(),
        finalAttempt: false,
      };
      const run = () =>
        kind === "document"
          ? ingestDocument({
              ...common,
              documentId: source.externalId,
              contentType: "text",
            })
          : ingestFile({
              ...common,
              filename: "request.txt",
              mimeType: "text/plain",
            });
      expect(await run()).toEqual({ partitionKey });
      expect(extractDocumentGraph).toHaveBeenCalledOnce();
      expect(
        await getSourceIngestionOperationById({
          db: database,
          userId,
          partitionKey,
          operationId: operation.operationId,
        }),
      ).toMatchObject({ status: "completed" });
      expect(await run()).toEqual({ partitionKey });
      expect(extractDocumentGraph).toHaveBeenCalledOnce();
    },
  );

  it("uses the replayed filename when the first queued file job starts", async () => {
    const userId = "file-queued-filename-replay";
    const content = "Original file text";
    await database.insert(users).values({ id: userId });
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "stable-file",
        metadata: { rawContent: content, filename: "old-name.txt" },
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Expected source");
    const operation = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: hashSourceContent(content),
    });
    await service.updateIngestionMetadata({
      userId,
      sourceId: source.id,
      partitionKey: undefined,
      metadata: { filename: "current-name.txt" },
      scope: "personal",
    });
    convertToMarkdown.mockResolvedValue({
      markdown: "Converted file text",
      title: null,
    });
    await ingestFile({
      db: database,
      userId,
      sourceId: source.id,
      operationId: operation.operationId,
      expectedSourceVersion: operation.sourceVersion,
      filename: "old-name.txt",
      mimeType: "text/plain",
      timestamp: new Date(),
      finalAttempt: false,
    });
    expect(convertToMarkdown).toHaveBeenCalledWith({
      buffer: Buffer.from(content),
      filename: "current-name.txt",
      mimeType: "text/plain",
    });
    expect(extractDocumentGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "current-name.txt",
        content: "Converted file text",
      }),
    );
    const [stored] = await database
      .select({ metadata: sources.metadata })
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(stored?.metadata).toMatchObject({
      rawContent: content,
      convertedMarkdown: "Converted file text",
      filename: "current-name.txt",
    });
    expect(
      await getSource({ userId, sourceId: source.id, includeContent: true }),
    ).toMatchObject({
      source: {
        title: "current-name.txt",
        content: { text: "Converted file text", format: "markdown" },
      },
    });
  });

  it("reuses converted HTML after extraction failure and converts a changed HTML revision once", async () => {
    convertToMarkdown.mockReset();
    extractDocumentGraph.mockReset();
    const userId = "html-conversion-retry";
    await database.insert(users).values({ id: userId });
    const html =
      "<h1>Original</h1><p>Keep <a href='https://example.com'>this link</a>.</p>";
    const markdown = "# Original\n\nKeep [this link](https://example.com).";
    const [source] = await database
      .insert(sources)
      .values({
        userId,
        type: "document",
        externalId: "html-document",
        metadata: { rawContent: html },
        status: "pending",
      })
      .returning();
    if (!source) throw new Error("Expected HTML source");
    const operation = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: hashSourceContent(html),
    });
    convertToMarkdown.mockResolvedValue({ markdown, title: "Converted title" });
    extractDocumentGraph
      .mockRejectedValueOnce(new Error("External extraction failed"))
      .mockResolvedValue(undefined);
    const job = {
      db: database,
      userId,
      sourceId: source.id,
      operationId: operation.operationId,
      expectedSourceVersion: operation.sourceVersion,
      documentId: source.externalId,
      contentType: "html" as const,
      timestamp: new Date(),
      finalAttempt: false,
    };
    await expect(ingestDocument(job)).rejects.toThrow(
      "External extraction failed",
    );
    expect(await service.fetchText(userId, source.id)).toBe(markdown);
    await ingestDocument(job);
    expect(convertToMarkdown).toHaveBeenCalledTimes(1);
    expect(convertToMarkdown).toHaveBeenCalledWith({
      buffer: Buffer.from(html),
      filename: "html-document.html",
      mimeType: "text/html",
    });
    expect(extractDocumentGraph).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: markdown, title: "Converted title" }),
    );
    const [converted] = await database
      .select()
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(converted?.metadata).toMatchObject({
      rawContent: html,
      convertedMarkdown: markdown,
      convertedToMarkdown: true,
    });
    expect(
      await getSource({ userId, sourceId: source.id, includeContent: true }),
    ).toMatchObject({
      source: { content: { text: markdown, format: "markdown" } },
    });
    const changedHtml = "<p>Changed HTML</p>";
    const version = await service.replaceInlineContent({
      userId,
      sourceId: source.id,
      partitionKey: undefined,
      content: changedHtml,
      contentHash: hashSourceContent(changedHtml),
      metadata: {},
      scope: "personal",
      timestamp: new Date(),
      status: "pending",
      replaceDerivedLinks: true,
    });
    const [changed] = await database
      .select()
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(changed?.metadata).toEqual({ rawContent: changedHtml });
    const revision = await createSourceIngestionOperation({
      db: database,
      userId,
      sourceId: source.id,
      externalId: source.externalId,
      contentHash: hashSourceContent(changedHtml),
      expectedSourceVersion: version,
    });
    convertToMarkdown.mockResolvedValue({
      markdown: "Changed HTML",
      title: "Changed title",
    });
    await ingestDocument({
      ...job,
      operationId: revision.operationId,
      expectedSourceVersion: revision.sourceVersion,
    });
    expect(convertToMarkdown).toHaveBeenCalledTimes(2);
    expect(convertToMarkdown).toHaveBeenLastCalledWith({
      buffer: Buffer.from(changedHtml),
      filename: "html-document.html",
      mimeType: "text/html",
    });
    expect(await service.fetchText(userId, source.id)).toBe("Changed HTML");
    const [reconverted] = await database
      .select({ metadata: sources.metadata })
      .from(sources)
      .where(eq(sources.id, source.id));
    expect(reconverted?.metadata).toMatchObject({
      rawContent: changedHtml,
      convertedMarkdown: "Changed HTML",
    });
  });

  it.each(["", " \n\t "])(
    "records a durable content failure for %j without discarding payloads",
    async (markdown) => {
      const userId = `unreadable-file-${markdown.length}`;
      const timestamp = new Date("2026-09-10T08:00:00Z");
      await database.insert(users).values({ id: userId });
      const [parent] = await database
        .insert(sources)
        .values({
          userId,
          type: "document",
          externalId: "message",
          status: "completed",
          metadata: { rawContent: "Retain the parent message body." },
        })
        .returning();
      const [file] = await database
        .insert(sources)
        .values({
          userId,
          type: "document",
          externalId: "attachment",
          parentSource: parent!.id,
          status: "pending",
          metadata: { rawContent: originalContent },
        })
        .returning();
      const processing = await createSourceIngestionOperation({
        db: database,
        userId,
        sourceId: file!.id,
        externalId: file!.externalId,
        contentHash: hashSourceContent(originalContent),
      });
      convertToMarkdown.mockResolvedValue({ markdown, title: null });
      const job = {
        db: database,
        userId,
        sourceId: file!.id,
        expectedSourceVersion: processing.sourceVersion,
        filename: "attachment.txt",
        mimeType: "text/plain",
        timestamp,
        operationId: processing.operationId,
        finalAttempt: false,
      };
      await ingestFile(job);
      const receipt = await getSourceIngestionOperationById({
        db: database,
        userId,
        operationId: processing.operationId,
      });
      expect(receipt).toMatchObject({
        status: "failed",
        stage: "content",
        errorCode: "UNREADABLE_CONTENT",
        completedAt: expect.any(Date),
      });
      expect(extractDocumentGraph).not.toHaveBeenCalled();
      expect(
        await database
          .select({ status: sources.status, metadata: sources.metadata })
          .from(sources)
          .where(eq(sources.id, file!.id)),
      ).toEqual([
        { status: "failed", metadata: { rawContent: originalContent } },
      ]);
      expect(
        await database
          .select({ status: sources.status, metadata: sources.metadata })
          .from(sources)
          .where(eq(sources.id, parent!.id)),
      ).toEqual([
        {
          status: "completed",
          metadata: { rawContent: "Retain the parent message body." },
        },
      ]);
      const conversionCount = convertToMarkdown.mock.calls.length;
      await ingestFile(job);
      expect(convertToMarkdown).toHaveBeenCalledTimes(conversionCount);
      expect(
        await getSourceIngestionOperationById({
          db: database,
          userId,
          operationId: processing.operationId,
        }),
      ).toEqual(receipt);
    },
  );

  it.each([
    {
      filename: "attachment.pdf",
      mimeType: "application/pdf",
      finalAttempt: false,
    },
    {
      filename: "attachment.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      finalAttempt: true,
    },
  ])(
    "reuses converted Markdown when $filename extraction is retried",
    async ({ filename, mimeType, finalAttempt }) => {
      convertToMarkdown.mockReset();
      extractDocumentGraph.mockReset();
      const userId = `converted-retry-${filename}`;
      await database.insert(users).values({ id: userId });
      const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
      const [file] = await database
        .insert(sources)
        .values({
          userId,
          type: "document",
          externalId: filename,
          status: "pending",
          contentType: mimeType,
          contentLength: bytes.length,
        })
        .returning();
      if (!file) throw new Error("File source was not created");
      const operation = await createSourceIngestionOperation({
        db: database,
        userId,
        sourceId: file.id,
        externalId: filename,
        contentHash: hashSourceContent(bytes),
      });
      const readBlob = vi
        .spyOn(blobClient, "getObject")
        .mockResolvedValue(Readable.from([bytes]));
      convertToMarkdown.mockResolvedValue({
        markdown: "# Converted attachment",
        title: "Attachment",
      });
      extractDocumentGraph
        .mockRejectedValueOnce(new Error("External extraction failed"))
        .mockResolvedValueOnce(undefined);
      const job = {
        db: database,
        userId,
        sourceId: file.id,
        operationId: operation.operationId,
        expectedSourceVersion: operation.sourceVersion,
        filename,
        mimeType,
        timestamp: new Date(),
        finalAttempt,
      };
      try {
        await expect(ingestFile(job)).rejects.toThrow(
          "External extraction failed",
        );
        const partitionKey = finalAttempt
          ? undefined
          : contextPartitionKeySchema.parse("file:retry-partition");
        if (partitionKey !== undefined) {
          await setPartitionMigrationState(database, {
            userId,
            expectedState: "unmigrated",
            expectedVersion: 0,
            nextState: "migrating",
          });
          const [current] = await database
            .select({ version: sources.version })
            .from(sources)
            .where(eq(sources.id, file.id));
          if (!current) throw new Error("File source was not found");
          await reclassifySourcePartition(database, {
            userId,
            sourceId: file.id,
            expectedPartitionKey: null,
            expectedSourceVersion: current.version,
            targetPartitionKey: partitionKey,
            bindingGeneration: "file-retry-move",
          });
          await setPartitionMigrationState(database, {
            userId,
            expectedState: "migrating",
            expectedVersion: 1,
            nextState: "migrated",
            unassignedPartitionKey: partitionKey,
          });
        }
        if (finalAttempt)
          await retrySourceIngestionOperation({
            db: database,
            userId,
            operationId: operation.operationId,
          });
        await ingestFile(job);
        expect(readBlob).toHaveBeenCalledOnce();
        expect(convertToMarkdown).toHaveBeenCalledOnce();
        expect(convertToMarkdown).toHaveBeenCalledWith({
          buffer: bytes,
          filename,
          mimeType,
        });
        expect(extractDocumentGraph).toHaveBeenLastCalledWith(
          expect.objectContaining({ content: "# Converted attachment" }),
        );
        expect(
          await getSourceIngestionOperationById({
            db: database,
            userId,
            operationId: operation.operationId,
            ...(partitionKey !== undefined ? { partitionKey } : {}),
          }),
        ).toMatchObject({ status: "completed", errorCode: null });
      } finally {
        readBlob.mockRestore();
      }
    },
  );
  it.each(["document", "file"] as const)(
    "closes a final-attempt %s failure after metadata replay and protects newer content",
    async (kind) => {
      for (const revision of ["metadata", "content"] as const) {
        extractDocumentGraph.mockReset();
        const userId = `final-attempt-${kind}-${revision}`;
        await database.insert(users).values({ id: userId });
        const [source] = await database
          .insert(sources)
          .values({
            userId,
            type: "document",
            externalId: "source",
            status: "pending",
            metadata: { rawContent: "content", convertedToMarkdown: true },
          })
          .returning();
        if (!source) throw new Error("Source missing");
        const operationInput = {
          db: database,
          userId,
          sourceId: source.id,
          externalId: source.externalId,
        };
        const accepted = await createSourceIngestionOperation({
          ...operationInput,
          contentHash: hashSourceContent("content"),
        });
        extractDocumentGraph.mockImplementationOnce(
          async (input: { expectedSourceVersion: number }) => {
            if (revision === "metadata") {
              await service.updateIngestionMetadata({
                userId,
                sourceId: source.id,
                partitionKey: undefined,
                metadata: { title: "Updated while extracting" },
                scope: "personal",
              });
            } else {
              const sourceVersion = await service.replaceInlineContent({
                userId,
                sourceId: source.id,
                partitionKey: undefined,
                content: "newer content",
                metadata: {},
                scope: "personal",
                timestamp: new Date(),
                status: "pending",
              });
              await createSourceIngestionOperation({
                ...operationInput,
                contentHash: hashSourceContent("newer content"),
                expectedSourceVersion: sourceVersion,
              });
            }
            await withSourceWriteFence(
              database,
              {
                userId,
                sources: [
                  {
                    sourceId: source.id,
                    expectedSourceVersion: input.expectedSourceVersion,
                  },
                ],
              },
              async () => undefined,
            );
          },
        );
        const common = {
          db: database,
          userId,
          sourceId: source.id,
          operationId: accepted.operationId,
          expectedSourceVersion: accepted.sourceVersion,
          timestamp: new Date(),
          finalAttempt: true,
        };
        const run = () =>
          kind === "document"
            ? ingestDocument({
                ...common,
                documentId: "source",
                contentType: "markdown",
              })
            : ingestFile({
                ...common,
                filename: "source.pdf",
                mimeType: "application/pdf",
              });
        await expect(run()).rejects.toMatchObject({
          code: "SOURCE_VERSION_CONFLICT",
        });
        const receipt = await getSourceIngestionOperationById({
          db: database,
          userId,
          operationId: accepted.operationId,
        });
        expect(receipt).toMatchObject({
          status: "failed",
          errorCode:
            revision === "metadata"
              ? "EXTRACTION_FAILED"
              : "SUPERSEDED_OPERATION",
        });
        const [current] = await database
          .select()
          .from(sources)
          .where(eq(sources.id, source.id));
        if (revision === "content") {
          expect(current).toMatchObject({
            status: "pending",
            metadata: { rawContent: "newer content" },
          });
        } else {
          expect(current?.status).toBe("failed");
          await retrySourceIngestionOperation({
            db: database,
            userId,
            operationId: accepted.operationId,
          });
          extractDocumentGraph.mockResolvedValueOnce(undefined);
          await run();
          expect(
            await getSourceIngestionOperationById({
              db: database,
              userId,
              operationId: accepted.operationId,
            }),
          ).toMatchObject({ status: "completed" });
        }
      }
    },
  );
});
