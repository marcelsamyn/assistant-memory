import { hashSourceContent } from "./source-processing";
import { hashSourceExtractionRevision } from "./source-revision";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp, toNodeListener } from "h3";
import { Client as MinioClient } from "minio";
import { createServer, type Server } from "node:http";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { confirmCommitment, dismissCommitment } from "~/lib/commitments";
import { ingestFileResponseSchema } from "~/lib/schemas/ingest-file";
import type { SourceContext } from "~/lib/schemas/source-context";
import { SourceService } from "~/lib/sources";
import { newTypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";
import {
  resetTestOverrides,
  setSkipEmbeddingPersistence,
  setSkipJobEnqueue,
  setSkipSemanticSearch,
} from "~/utils/test-overrides";

vi.hoisted(() => vi.resetModules());

const queue = vi.hoisted(() => ({
  add: vi
    .fn<(name: string, input: unknown) => Promise<void>>()
    .mockResolvedValue(undefined),
}));
vi.mock("~/lib/queues", () => ({ batchQueue: queue }));
vi.mock("~/lib/converters/markitdown", () => ({
  convertToMarkdown: async ({ buffer }: { buffer: Buffer }) => ({
    markdown: buffer.toString("utf8"),
    title: null,
  }),
}));
const ai = vi.hoisted(() => ({
  excerpt: "Please review the contract and send your comments.",
}));
vi.mock("~/lib/ai", async (original) => ({
  ...(await original<typeof import("~/lib/ai")>()),
  createCompletionClient: async () => ({}),
  parseStructuredCompletion: async (
    _client: unknown,
    input: { messages: { content: string }[] },
    audit: { task: string },
  ) => {
    const prompt = input.messages.map((message) => message.content).join("\n");
    const sourceRef = prompt.match(
      /Allowed source refs:\n- sourceRef: ([^;\n]+)/,
    )?.[1];
    const parsed =
      audit.task === "document_spine"
        ? {
            thesis: "Review a document.",
            spineConcepts: [
              {
                label: "Document review",
                description: "Review the requested document.",
              },
            ],
          }
        : audit.task === "commitment_presentation"
          ? { excerpt: null, why: null }
          : {
              nodes: [
                { id: "temp_request", type: "Task", label: "Review document" },
              ],
              attributeClaims: [
                {
                  subjectId: "temp_request",
                  predicate: "HAS_TASK_STATUS",
                  objectValue: "pending",
                  statement: ai.excerpt,
                  sourceRef,
                  assertionKind: "assistant_inferred",
                  emailRequestEvidence: {
                    kind: "direct_request",
                    lifecycle: "request",
                    excerpt: ai.excerpt,
                    supportingSourceRefs: [sourceRef],
                  },
                },
              ],
            };
    return { choices: [{ message: { parsed } }] };
  },
}));

const pgHost = process.env["TEST_PG_HOST"] ?? "localhost";
const pgPort = Number(process.env["TEST_PG_PORT"] ?? 5431);
const pgUser = process.env["TEST_PG_USER"] ?? "postgres";
const pgPassword = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const dsn = (name: string): string =>
  `postgres://${pgUser}:${pgPassword}@${pgHost}:${pgPort}/${name}`;
const adminDsn = dsn(process.env["TEST_PG_ADMIN_DB"] ?? "postgres");
const minio = new MinioClient({
  endPoint: process.env["TEST_MINIO_ENDPOINT"] ?? "localhost",
  port: Number(process.env["TEST_MINIO_PORT"] ?? 9000),
  useSSL: false,
  accessKey: process.env["TEST_MINIO_ACCESS_KEY"] ?? "minio",
  secretKey: process.env["TEST_MINIO_SECRET_KEY"] ?? "minio123",
});
async function available(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn });
  try {
    await client.connect();
    await minio.listBuckets();
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

const context: SourceContext = {
  version: 1,
  sourceKind: "email",
  purpose: "Follow requests",
  accountId: "mailbox",
  authenticatedUser: { email: "owner@example.com" },
  sender: { email: "lena@example.com" },
  recipients: [{ email: "owner@example.com", recipientRole: "to" }],
  direction: "incoming",
  deliveryKind: "person_message",
  relationship: "recipient",
  messageId: "message",
  threadId: "thread",
  currentMessageRole: "current_message",
  authoredAt: "2026-09-10T08:00:00.000Z",
  completeness: "complete",
};

describe.skipIf(!(await available()))(
  "source extraction revisions across ingestion transports",
  () => {
    const name = `memory_revision_${Date.now()}`;
    const bucket = `source-revision-${Date.now()}`;
    let pool: Pool;
    let database: NodePgDatabase<typeof schema>;
    let service: SourceService;
    let server: Server;
    let baseUrl: string;
    let saveMemory: typeof import("./save-document").saveMemory;
    let ingestDocument: typeof import("~/lib/jobs/ingest-document").ingestDocument;
    let ingestFile: typeof import("~/lib/jobs/ingest-file").ingestFile;

    beforeAll(async () => {
      const admin = new Client({ connectionString: adminDsn });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      await admin.end();
      pool = new Pool({ connectionString: dsn(name), max: 4 });
      database = drizzle(pool, { schema, casing: "snake_case" });
      await migrate(database, { migrationsFolder: "./drizzle" });
      await minio.makeBucket(bucket);
      service = new SourceService(database, minio, bucket, 1);
      setTestDatabase(database);
      setSkipEmbeddingPersistence(true);
      setSkipJobEnqueue(true);
      setSkipSemanticSearch(true);
      vi.doMock("~/db", () => ({ default: database }));
      vi.doMock("~/lib/sources", async () => ({
        ...(await vi.importActual<typeof import("~/lib/sources")>(
          "~/lib/sources",
        )),
        sourceService: service,
      }));
      ({ saveMemory } = await import("./save-document"));
      ({ ingestDocument } = await import("~/lib/jobs/ingest-document"));
      ({ ingestFile } = await import("~/lib/jobs/ingest-file"));
      const app = createApp();
      app.use(
        "/ingest/file",
        (await import("~/routes/ingest/file.post")).default,
      );
      server = createServer(toNodeListener(app));
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP test server");
      baseUrl = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      for (const source of await database.select().from(schema.sources))
        await service.deleteRawBlobIfPresent(source.userId, source.id);
      await minio.removeBucket(bucket);
      resetTestOverrides();
      setTestDatabase(null);
      await pool.end();
      const admin = new Client({ connectionString: adminDsn });
      await admin.connect();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
      vi.doUnmock("~/db");
      vi.doUnmock("~/lib/sources");
      vi.resetModules();
    });

    async function accept(
      kind: "document" | "file",
      userId: string,
      sourceContext: SourceContext,
      content = ai.excerpt,
      title?: string,
      filename = "message.txt",
    ) {
      await database
        .insert(schema.users)
        .values({ id: userId })
        .onConflictDoNothing();
      if (kind === "document")
        return saveMemory({
          userId,
          updateExisting: false,
          document: {
            id: "message",
            content,
            contentType: "text",
            scope: "personal",
            sourceContext,
            ...(title === undefined ? {} : { title }),
          },
        });
      const form = new FormData();
      form.set("userId", userId);
      form.set("externalId", "message");
      form.set("sourceContext", JSON.stringify(sourceContext));
      if (title !== undefined) form.set("title", title);
      form.set("file", new Blob([content], { type: "text/plain" }), filename);
      const response = await fetch(`${baseUrl}/ingest/file`, {
        method: "POST",
        body: form,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return ingestFileResponseSchema.parse(await response.json());
    }

    async function runAccepted(
      kind: "document" | "file",
      operationId: string | undefined,
    ): Promise<void> {
      const job = queue.add.mock.calls.findLast(
        ([, input]) =>
          typeof input === "object" &&
          input !== null &&
          "operationId" in input &&
          input.operationId === operationId,
      );
      if (!job) throw new Error("Expected queued ingestion operation");
      if (kind === "document") {
        const { IngestDocumentJobInputSchema } = await import(
          "~/lib/jobs/ingest-document"
        );
        await ingestDocument({
          db: database,
          ...IngestDocumentJobInputSchema.parse(job[1]),
        });
      } else {
        const { IngestFileJobInputSchema } = await import(
          "~/lib/jobs/ingest-file"
        );
        await ingestFile({
          db: database,
          ...IngestFileJobInputSchema.parse(job[1]),
        });
      }
    }

    async function activeStatuses(userId: string) {
      return database
        .select()
        .from(schema.claims)
        .where(
          and(
            eq(schema.claims.userId, userId),
            eq(schema.claims.predicate, "HAS_TASK_STATUS"),
            eq(schema.claims.status, "active"),
          ),
        );
    }

    it.each(["document", "file"] as const)(
      "removes orphaned %s nodes and projections before extracting the corrected revision",
      async (kind) => {
        const userId = `revision-orphans-${kind}`;
        const first = await accept(kind, userId, context);
        await runAccepted(kind, first.ingestionOperationId);
        const originalNodes = await database
          .select()
          .from(schema.nodes)
          .where(eq(schema.nodes.userId, userId));
        expect(
          originalNodes.filter((node) => node.nodeType === "Document"),
        ).toHaveLength(1);
        expect(
          originalNodes.filter((node) => node.nodeType === "Task"),
        ).toHaveLength(1);
        const task = originalNodes.find((node) => node.nodeType === "Task");
        if (!task) throw new Error("Expected extracted task");
        await database.insert(schema.commitmentPresentations).values({
          taskId: task.id,
          userId,
          sourceId: first.sourceId,
          excerpt: ai.excerpt,
          why: "The prior revision requested a document review.",
        });
        // Legacy extracted evidence can mention nodes without source links,
        // including a participant referenced only as the claim's author.
        const subjectId = newTypeId("node");
        const objectId = newTypeId("node");
        const participantId = newTypeId("node");
        const claimOnlyIds = [subjectId, objectId, participantId];
        await database.insert(schema.nodes).values(
          claimOnlyIds.map((id) => ({
            id,
            userId,
            nodeType: "Person" as const,
          })),
        );
        const [legacyClaim] = await database
          .insert(schema.claims)
          .values({
            userId,
            sourceId: first.sourceId,
            subjectNodeId: subjectId,
            objectNodeId: objectId,
            assertedByNodeId: participantId,
            assertedByKind: "participant",
            predicate: "RELATED_TO",
            statement: "The prior revision said these people knew each other.",
            statedAt: new Date("2026-09-10T08:00:00Z"),
          })
          .returning();
        if (!legacyClaim) throw new Error("Expected legacy claim");
        await database.insert(schema.nodeMetadata).values(
          claimOnlyIds.map((nodeId) => ({
            nodeId,
            label: `Obsolete ${nodeId}`,
            description: "Only supported by the prior revision.",
          })),
        );
        const originalIds = [
          ...originalNodes.map((node) => node.id),
          ...claimOnlyIds,
        ];
        const vector = Array.from({ length: 1024 }, () => 0.01);
        await database.insert(schema.nodeEmbeddings).values(
          originalIds.map((nodeId) => ({
            nodeId,
            embedding: vector,
            modelName: "test",
          })),
        );
        await database.insert(schema.aliases).values(
          originalIds.map((canonicalNodeId) => ({
            userId,
            canonicalNodeId,
            aliasText: `Old ${canonicalNodeId}`,
            normalizedAliasText: `old ${canonicalNodeId}`,
          })),
        );
        await database.insert(schema.claimEmbeddings).values({
          claimId: legacyClaim.id,
          embedding: vector,
          modelName: "test",
        });
        const correctedContext = {
          ...context,
          deliveryKind: "newsletter" as const,
        };
        const correction = await accept(kind, userId, correctedContext);
        expect(correction.sourceId).toBe(first.sourceId);
        expect(
          await database
            .select()
            .from(schema.nodes)
            .where(inArray(schema.nodes.id, originalIds)),
        ).toEqual([]);
        expect(
          await database
            .select()
            .from(schema.nodeMetadata)
            .where(inArray(schema.nodeMetadata.nodeId, originalIds)),
        ).toEqual([]);
        expect(
          await database
            .select()
            .from(schema.nodeEmbeddings)
            .where(inArray(schema.nodeEmbeddings.nodeId, originalIds)),
        ).toEqual([]);
        expect(
          await database
            .select()
            .from(schema.aliases)
            .where(inArray(schema.aliases.canonicalNodeId, originalIds)),
        ).toEqual([]);
        expect(
          await database
            .select()
            .from(schema.claimEmbeddings)
            .where(eq(schema.claimEmbeddings.claimId, legacyClaim.id)),
        ).toEqual([]);
        expect(
          await database
            .select()
            .from(schema.commitmentPresentations)
            .where(eq(schema.commitmentPresentations.userId, userId)),
        ).toEqual([]);

        await runAccepted(kind, correction.ingestionOperationId);
        const documents = await database
          .select()
          .from(schema.nodes)
          .where(
            and(
              eq(schema.nodes.userId, userId),
              eq(schema.nodes.nodeType, "Document"),
            ),
          );
        expect(documents).toHaveLength(1);
        const [document] = documents;
        if (!document) throw new Error("Expected corrected Document");
        expect(
          await database
            .select()
            .from(schema.sourceLinks)
            .where(eq(schema.sourceLinks.sourceId, first.sourceId)),
        ).toMatchObject([{ nodeId: document.id }]);
        expect(await activeStatuses(userId)).toEqual([]);

        const changed = await accept(
          kind,
          userId,
          correctedContext,
          "Corrected newsletter content.",
        );
        expect(
          await database
            .select()
            .from(schema.nodes)
            .where(eq(schema.nodes.id, document.id)),
        ).toEqual([]);
        await runAccepted(kind, changed.ingestionOperationId);
        expect(
          await database
            .select()
            .from(schema.nodes)
            .where(
              and(
                eq(schema.nodes.userId, userId),
                eq(schema.nodes.nodeType, "Document"),
              ),
            ),
        ).toHaveLength(1);
      },
      30_000,
    );

    it("preserves shared nodes supported by source links or any claim role and leaves unrelated nodes intact", async () => {
      const userId = "revision-shared-nodes";
      const first = await accept("document", userId, context);
      await runAccepted("document", first.ingestionOperationId);
      const [otherSource] = await database
        .insert(schema.sources)
        .values({
          userId,
          type: "document",
          externalId: "other-document",
        })
        .returning();
      if (!otherSource) throw new Error("Expected independent source");
      const linkedId = newTypeId("node");
      const subjectId = newTypeId("node");
      const objectId = newTypeId("node");
      const participantId = newTypeId("node");
      const unrelatedId = newTypeId("node");
      const sharedIds = [linkedId, subjectId, objectId, participantId];
      const retainedIds = [...sharedIds, unrelatedId];
      const originalNodes = await database
        .insert(schema.nodes)
        .values(
          retainedIds.map((id) => ({
            id,
            userId,
            nodeType: "Person" as const,
          })),
        )
        .returning();
      const originalMetadata = await database
        .insert(schema.nodeMetadata)
        .values(
          retainedIds.map((nodeId) => ({
            nodeId,
            label: `Retained ${nodeId}`,
            description: "Retained independent evidence.",
          })),
        )
        .returning();
      const originalEmbeddings = await database
        .insert(schema.nodeEmbeddings)
        .values(
          retainedIds.map((nodeId) => ({
            nodeId,
            embedding: Array.from({ length: 1024 }, () => 0.01),
            modelName: "test",
          })),
        )
        .returning();
      await database
        .insert(schema.sourceLinks)
        .values([
          ...sharedIds.map((nodeId) => ({ sourceId: first.sourceId, nodeId })),
          { sourceId: otherSource.id, nodeId: linkedId },
        ]);
      const [otherClaim] = await database
        .insert(schema.claims)
        .values({
          userId,
          sourceId: otherSource.id,
          subjectNodeId: subjectId,
          objectNodeId: objectId,
          assertedByNodeId: participantId,
          assertedByKind: "participant",
          predicate: "RELATED_TO",
          statement: "Independent evidence supports all three claim roles.",
          statedAt: new Date("2026-09-10T08:00:00Z"),
        })
        .returning();
      if (!otherClaim) throw new Error("Expected independent claim");
      await accept("document", userId, {
        ...context,
        deliveryKind: "newsletter",
      });
      expect(
        await database
          .select()
          .from(schema.nodes)
          .where(inArray(schema.nodes.id, retainedIds)),
      ).toEqual(expect.arrayContaining(originalNodes));
      expect(
        await database
          .select()
          .from(schema.nodeMetadata)
          .where(inArray(schema.nodeMetadata.nodeId, retainedIds)),
      ).toEqual(expect.arrayContaining(originalMetadata));
      expect(
        await database
          .select()
          .from(schema.nodeEmbeddings)
          .where(inArray(schema.nodeEmbeddings.nodeId, retainedIds)),
      ).toEqual(expect.arrayContaining(originalEmbeddings));
      expect(
        await database
          .select()
          .from(schema.sourceLinks)
          .where(eq(schema.sourceLinks.sourceId, otherSource.id)),
      ).toMatchObject([{ nodeId: linkedId }]);
      expect(
        await database
          .select()
          .from(schema.claims)
          .where(eq(schema.claims.id, otherClaim.id)),
      ).toEqual([otherClaim]);
    });

    it.each(["title", "filename"] as const)(
      "updates the linked Document %s on a completed file replay without re-extracting",
      async (field) => {
        const userId = `file-${field}-replay`;
        const originalLabel =
          field === "title" ? "Original title" : "Original file.txt";
        const correctedLabel =
          field === "title" ? "Corrected title" : "Corrected file.txt";
        const content = "Please review the contract and send your comments.";
        const accepted = await accept(
          "file",
          userId,
          context,
          content,
          field === "title" ? originalLabel : undefined,
          "Original file.txt",
        );
        await runAccepted("file", accepted.ingestionOperationId);
        const linkedDocument = () =>
          database
            .select({
              nodeId: schema.nodes.id,
              label: schema.nodeMetadata.label,
              canonicalLabel: schema.nodeMetadata.canonicalLabel,
              description: schema.nodeMetadata.description,
            })
            .from(schema.sourceLinks)
            .innerJoin(
              schema.nodes,
              eq(schema.nodes.id, schema.sourceLinks.nodeId),
            )
            .innerJoin(
              schema.nodeMetadata,
              eq(schema.nodeMetadata.nodeId, schema.nodes.id),
            )
            .where(
              and(
                eq(schema.sourceLinks.sourceId, accepted.sourceId),
                eq(schema.nodes.nodeType, "Document"),
              ),
            );
        const original = await linkedDocument();
        expect(original).toEqual([
          expect.objectContaining({ label: originalLabel }),
        ]);
        const queuedCount = queue.add.mock.calls.length;
        const originalClaims = await activeStatuses(userId);

        const replay = await accept(
          "file",
          userId,
          context,
          content,
          field === "title" ? correctedLabel : undefined,
          "Corrected file.txt",
        );

        expect(replay).toMatchObject({
          sourceId: accepted.sourceId,
          ingestionOperationId: accepted.ingestionOperationId,
          message: "File revision already processed",
        });
        expect(await linkedDocument()).toEqual([
          {
            ...original[0],
            label: correctedLabel,
            canonicalLabel: correctedLabel.toLowerCase(),
          },
        ]);
        const [source] = await database
          .select({ metadata: schema.sources.metadata })
          .from(schema.sources)
          .where(eq(schema.sources.id, accepted.sourceId));
        expect(source?.metadata).toMatchObject({
          ...(field === "title"
            ? { title: correctedLabel }
            : { filename: correctedLabel }),
          convertedMarkdown: content,
        });
        expect(await activeStatuses(userId)).toEqual(originalClaims);
        expect(queue.add).toHaveBeenCalledTimes(queuedCount);
        expect(
          await database
            .select({
              operationId: schema.sourceIngestionOperations.operationId,
              status: schema.sourceIngestionOperations.status,
            })
            .from(schema.sourceIngestionOperations)
            .where(eq(schema.sourceIngestionOperations.userId, userId)),
        ).toEqual([
          { operationId: accepted.ingestionOperationId, status: "completed" },
        ]);

        const renamed = await accept(
          "file",
          userId,
          context,
          content,
          undefined,
          "Renamed again.txt",
        );
        expect(renamed.ingestionOperationId).toBe(
          accepted.ingestionOperationId,
        );
        expect(await linkedDocument()).toEqual([
          expect.objectContaining({
            nodeId: original[0]?.nodeId,
            label: field === "title" ? correctedLabel : "Renamed again.txt",
            canonicalLabel:
              field === "title"
                ? correctedLabel.toLowerCase()
                : "renamed again.txt",
          }),
        ]);
        expect(queue.add).toHaveBeenCalledTimes(queuedCount);
      },
    );

    it.each(["document", "file"] as const)(
      "retracts corrected %s evidence and re-extracts context A→B→A and bytes A→B→A",
      async (kind) => {
        const userId = `revision-${kind}`;
        ai.excerpt = "Please review the contract and send your comments.";
        const first = await accept(kind, userId, context);
        await runAccepted(kind, first.ingestionOperationId);
        expect(await activeStatuses(userId)).toHaveLength(1);
        const replay = await accept(
          kind,
          userId,
          { ...context, sourceUrl: "https://example.com/message" },
          ai.excerpt,
          "A display-only title",
        );
        expect(replay.ingestionOperationId).toBe(first.ingestionOperationId);
        for (const suppressed of [
          {
            ...context,
            recipients: [
              { email: "owner@example.com", recipientRole: "cc" as const },
            ],
          },
          { ...context, deliveryKind: "newsletter" as const },
        ]) {
          const correction = await accept(kind, userId, suppressed);
          expect(correction.sourceId).toBe(first.sourceId);
          expect(await activeStatuses(userId)).toHaveLength(0);
          await runAccepted(kind, correction.ingestionOperationId);
          expect(await activeStatuses(userId)).toHaveLength(0);
          const restored = await accept(kind, userId, context);
          expect(restored.ingestionOperationId).not.toBe(
            first.ingestionOperationId,
          );
          await runAccepted(kind, restored.ingestionOperationId);
          expect(await activeStatuses(userId)).toHaveLength(1);
        }
        const originalBytes = ai.excerpt;
        ai.excerpt = "Please review the invoice and approve the amount.";
        const changed = await accept(kind, userId, context);
        await runAccepted(kind, changed.ingestionOperationId);
        expect((await activeStatuses(userId))[0]?.statement).toBe(ai.excerpt);
        ai.excerpt = originalBytes;
        const returned = await accept(kind, userId, context);
        await runAccepted(kind, returned.ingestionOperationId);
        expect((await activeStatuses(userId))[0]?.statement).toBe(
          originalBytes,
        );
        expect(returned.ingestionOperationId).not.toBe(
          first.ingestionOperationId,
        );
        await runAccepted(kind, first.ingestionOperationId);
        expect((await activeStatuses(userId))[0]?.statement).toBe(
          originalBytes,
        );
      },
      30_000,
    );

    it.each([
      ["document", "confirm"],
      ["document", "dismiss"],
      ["file", "confirm"],
      ["file", "dismiss"],
    ] as const)(
      "preserves an explicit %s %s decision across context correction and restoration",
      async (kind, action) => {
        const userId = `revision-user-${kind}-${action}`;
        const first = await accept(kind, userId, context);
        await runAccepted(kind, first.ingestionOperationId);
        const [status] = await activeStatuses(userId);
        if (!status) throw new Error("Expected tentative request");
        const input = { userId, taskId: status.subjectNodeId };
        if (action === "confirm") await confirmCommitment(input);
        else await dismissCommitment(input);
        const correction = await accept(kind, userId, {
          ...context,
          deliveryKind: "newsletter",
        });
        await runAccepted(kind, correction.ingestionOperationId);
        const restored = await accept(kind, userId, context);
        await runAccepted(kind, restored.ingestionOperationId);
        const active = await activeStatuses(userId);
        if (action === "confirm")
          expect(active).toMatchObject([
            {
              subjectNodeId: status.subjectNodeId,
              assertedByKind: "user_confirmed",
            },
          ]);
        else expect(active).toHaveLength(0);
      },
      30_000,
    );
    it("removes historical source-derived user claims when context is corrected to newsletter", async () => {
      const userId = "revision-model-user-claim";
      const first = await accept("document", userId, {
        ...context,
        sourceKind: "document",
      });
      await runAccepted("document", first.ingestionOperationId);
      // Existing documents may carry model-attributed user claims. Provenance
      // must distinguish them from assertions on the manual action source.
      await database
        .update(schema.claims)
        .set({ assertedByKind: "user_confirmed" })
        .where(eq(schema.claims.sourceId, first.sourceId));
      expect(await activeStatuses(userId)).toMatchObject([
        { sourceId: first.sourceId, assertedByKind: "user_confirmed" },
      ]);
      const correction = await accept("document", userId, {
        ...context,
        deliveryKind: "newsletter",
      });
      expect(await activeStatuses(userId)).toHaveLength(0);
      await runAccepted("document", correction.ingestionOperationId);
      expect(await activeStatuses(userId)).toHaveLength(0);
    }, 30_000);

    it("includes extraction attributes while keeping byte hashes and equivalent context stable", () => {
      const bytes = hashSourceContent("source bytes");
      const extraction = {
        scope: "personal" as const,
        contentType: "text",
        author: "Original author",
        timestamp: new Date("2026-09-10T00:00:00Z"),
      };
      const first = hashSourceExtractionRevision(bytes, context, extraction);
      for (const changed of [
        { ...extraction, scope: "reference" as const },
        { ...extraction, contentType: "html" },
        { ...extraction, author: "Corrected author" },
        { ...extraction, timestamp: new Date("2026-09-11T00:00:00Z") },
      ])
        expect(hashSourceExtractionRevision(bytes, context, changed)).not.toBe(
          first,
        );
      expect(
        hashSourceExtractionRevision(
          bytes,
          { ...context, sourceUrl: "https://example.com/updated" },
          extraction,
        ),
      ).toBe(first);
      expect(hashSourceContent("source bytes")).toBe(bytes);
    });
  },
);
