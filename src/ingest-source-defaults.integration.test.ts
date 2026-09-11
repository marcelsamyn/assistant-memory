import { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp, readBody, toNodeListener } from "h3";
import { Client as MinioClient } from "minio";
import { createServer, type Server } from "node:http";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { contextualSourceExternalId } from "~/lib/ingestion/source-identity";
import { ingestDocumentResponseSchema } from "~/lib/schemas/ingest-document-request";

const host = process.env["TEST_PG_HOST"] ?? "localhost";
const port = Number(process.env["TEST_PG_PORT"] ?? 5431);
const user = process.env["TEST_PG_USER"] ?? "postgres";
const password = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const dsn = (name: string): string =>
  `postgres://${user}:${password}@${host}:${port}/${name}`;
async function available(): Promise<boolean> {
  const client = new Client({ connectionString: dsn("postgres") });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

const describeWithDatabase = (await available()) ? describe : describe.skip;

describeWithDatabase("concurrent first ingestion defaults", () => {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const dbName = `memory_ingest_defaults_${suffix}`;
  let database: NodePgDatabase<typeof schema>;
  let pool: Pool;
  let queue: Queue;
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    vi.resetModules();
    const admin = new Client({ connectionString: dsn("postgres") });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    pool = new Pool({ connectionString: dsn(dbName), max: 6 });
    database = drizzle(pool, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    const redisUrl = new URL(
      process.env["REDIS_URL"] ?? "redis://localhost:6380",
    );
    queue = new Queue(`memory-ingest-defaults-${suffix}`, {
      connection: { host: redisUrl.hostname, port: Number(redisUrl.port) },
    });
    await queue.waitUntilReady();
    vi.doMock("~/db", () => ({ default: database }));
    vi.doMock("~/lib/queues", () => ({ batchQueue: queue }));
    const { SourceService } = await import("~/lib/sources");
    vi.spyOn(MinioClient.prototype, "bucketExists").mockResolvedValue(true);
    const sourceService = new SourceService(
      database,
      new MinioClient({
        endPoint: "localhost",
        port: 9000,
        useSSL: false,
        accessKey: "unused",
        secretKey: "unused",
      }),
      "unused",
    );
    vi.doMock("~/lib/sources", async () => ({
      ...(await vi.importActual<typeof import("~/lib/sources")>(
        "~/lib/sources",
      )),
      sourceService,
    }));
    vi.stubGlobal("readBody", readBody);
    const app = createApp();
    app.use(
      "/ingest/document",
      (await import("~/routes/ingest/document.post")).default,
    );
    app.use(
      "/ingest/file",
      (await import("~/routes/ingest/file.post")).default,
    );
    server = createServer(toNodeListener(app));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("No HTTP address");
    origin = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await queue.obliterate({ force: true });
    await queue.close();
    await pool.end();
    const admin = new Client({ connectionString: dsn("postgres") });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
    for (const moduleId of ["~/db", "~/lib/queues", "~/lib/sources"])
      vi.doUnmock(moduleId);
    vi.resetModules();
  });

  it.each(["document", "file"] as const)(
    "reuses one revision for concurrent %s requests without timestamps",
    async (kind) => {
      const userId = `defaults-${kind}`;
      await database.insert(schema.users).values({ id: userId });
      const sourceContext = {
        version: 1,
        sourceKind: kind,
        currentMessageRole: "primary",
        accountId: "account-1",
        purpose: "Remember supplied material",
        relationship: "author",
        completeness: "complete",
      };
      const externalId = contextualSourceExternalId({
        externalId: kind,
        accountId: sourceContext.accountId,
      });
      const gate = await pool.connect();
      await gate.query("BEGIN");
      await gate.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [JSON.stringify(["source_identity", userId, "document", externalId])],
      );
      const pending: Promise<Response>[] = [];
      const send = (): Promise<Response> => {
        if (kind === "document")
          return fetch(`${origin}/ingest/document`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId,
              document: {
                id: kind,
                content: "Review this material",
                sourceContext,
              },
            }),
          });
        const form = new FormData();
        form.set(
          "file",
          new Blob(["Review this material"], { type: "text/plain" }),
          "material.txt",
        );
        form.set("userId", userId);
        form.set("externalId", kind);
        form.set("sourceContext", JSON.stringify(sourceContext));
        return fetch(`${origin}/ingest/file`, { method: "POST", body: form });
      };
      const waitForBlockedRequests = async (count: number): Promise<void> => {
        await expect
          .poll(
            async () => {
              const result = await pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1 AND wait_event = 'advisory'",
                [dbName],
              );
              return result.rows[0]?.count;
            },
            { timeout: 5_000, interval: 10 },
          )
          .toBe(count);
      };
      try {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date("2026-09-10T09:00:00.000Z"));
        pending.push(send());
        await waitForBlockedRequests(1);
        vi.setSystemTime(new Date("2026-09-10T09:00:01.000Z"));
        pending.push(send());
        await waitForBlockedRequests(2);
      } finally {
        await gate.query("COMMIT");
        gate.release();
        vi.useRealTimers();
      }
      const responses = await Promise.all(pending);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const accepted = await Promise.all(
        responses.map(async (response) =>
          ingestDocumentResponseSchema.parse(await response.json()),
        ),
      );
      expect(accepted[0]?.sourceId).toBe(accepted[1]?.sourceId);
      expect(accepted[0]?.ingestionOperationId).toBe(
        accepted[1]?.ingestionOperationId,
      );
      const operations = await database
        .select()
        .from(schema.sourceIngestionOperations)
        .where(eq(schema.sourceIngestionOperations.userId, userId));
      expect(operations).toHaveLength(1);
      expect(operations[0]?.status).toBe("queued");
      const operationId = accepted[0]?.ingestionOperationId;
      if (!operationId) throw new Error("Missing operation ID");
      const job = await queue.getJob(operationId);
      expect(job?.name).toBe(`ingest-${kind}`);
      expect(await job?.getState()).toBe("waiting");
    },
    15_000,
  );
});
