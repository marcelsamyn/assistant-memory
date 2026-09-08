import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { insertNewSources } from "~/lib/ingestion/insert-new-sources";
import { withSourceWriteFence } from "~/lib/partition-access";
import { sourceLifecycleCommandRequestSchema } from "~/lib/schemas/source-lifecycle";
import { applySourceLifecycleCommand } from "~/lib/source-lifecycle";
import { newTypeId } from "~/types/typeid";
import {
  resetTestOverrides,
  setSourceServiceOverride,
} from "~/utils/test-overrides";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (name: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${name}`;

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

describeIfServer("source write fence", () => {
  const dbName = `memory_source_write_fence_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;
  let database: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 120_000);

  afterAll(async () => {
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("blocks a delayed writer after tombstone without recreating source-derived records", async () => {
    const userId = "source-write-fence-user";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    await database.insert(schema.users).values({ id: userId });
    await database.insert(schema.sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "late-writer-document",
      metadata: { rawContent: "private source body" },
      status: "completed",
    });

    // Simulates a job that loaded version 0, then spent time converting or
    // waiting on an LLM while the user deleted the source.
    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000111",
        action: "tombstone",
      }),
    );

    let callbackRan = false;
    await expect(
      withSourceWriteFence(
        database,
        {
          userId,
          sources: [{ sourceId, expectedSourceVersion: 0 }],
        },
        async (tx) => {
          callbackRan = true;
          await tx.insert(schema.nodes).values({
            id: nodeId,
            userId,
            nodeType: "Document",
          });
          await tx.insert(schema.nodeMetadata).values({
            nodeId,
            label: "private source body",
            additionalData: {},
          });
          await tx.insert(schema.sourceLinks).values({ sourceId, nodeId });
          await tx.insert(schema.claims).values({
            userId,
            subjectNodeId: nodeId,
            objectValue: "private source body",
            predicate: "HAS_ATTRIBUTE",
            statement: "private source body",
            sourceId,
            scope: "personal",
            assertedByKind: "document_author",
            statedAt: new Date(),
            status: "active",
          });
        },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_TOMBSTONED" });
    expect(callbackRan).toBe(false);

    await expect(
      database.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.sourceLinks)
        .where(eq(schema.sourceLinks.sourceId, sourceId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.sourceId, sourceId)),
    ).resolves.toEqual([]);
  });

  it("does not invert root and child locks against a globally sorted source writer", async () => {
    const userId = "source-write-fence-tree-lock-order";
    const [childSourceId, rootSourceId] = [
      newTypeId("source"),
      newTypeId("source"),
    ].sort();
    if (!childSourceId || !rootSourceId)
      throw new Error("Expected two source identifiers");
    await database.insert(schema.users).values({ id: userId });
    await database.insert(schema.sources).values([
      {
        id: rootSourceId,
        userId,
        type: "meeting_transcript",
        externalId: "root-lock-order",
      },
      {
        id: childSourceId,
        userId,
        type: "conversation_message",
        externalId: "child-lock-order",
        parentSource: rootSourceId,
      },
    ]);

    const writer = new Client({ connectionString: dsnFor(dbName) });
    const lifecycleClient = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([writer.connect(), lifecycleClient.connect()]);
    const lifecycleDb = drizzle(lifecycleClient, {
      schema,
      casing: "snake_case",
    });
    try {
      await writer.query("BEGIN");
      // This is the first half of a source writer's globally sorted lock set.
      await writer.query("SELECT id FROM sources WHERE id = $1 FOR UPDATE", [
        childSourceId,
      ]);
      const tombstone = applySourceLifecycleCommand(
        lifecycleDb,
        sourceLifecycleCommandRequestSchema.parse({
          userId,
          sourceId: rootSourceId,
          expectedPartitionKey: null,
          expectedSourceVersion: 0,
          commandId: "00000000-0000-4000-8000-000000000114",
          action: "tombstone",
        }),
      );
      // Let the lifecycle transaction reach the child lock. If it had locked
      // the root first, the second half below would time out (the old cycle).
      await new Promise((resolve) => setTimeout(resolve, 30));
      await writer.query("SET LOCAL lock_timeout = '500ms'");
      await expect(
        writer.query("SELECT id FROM sources WHERE id = $1 FOR UPDATE", [
          rootSourceId,
        ]),
      ).resolves.toBeDefined();
      await writer.query("COMMIT");
      await expect(tombstone).resolves.toMatchObject({ state: "tombstoned" });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await Promise.all([writer.end(), lifecycleClient.end()]);
    }
  });

  it("does not create transcript child sources after the pre-created root was tombstoned", async () => {
    const userId = "source-write-fence-transcript-user";
    const rootSourceId = newTypeId("source");
    await database.insert(schema.users).values({ id: userId });
    await database.insert(schema.sources).values({
      id: rootSourceId,
      userId,
      type: "meeting_transcript",
      externalId: "tombstoned-transcript",
      status: "pending",
    });
    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: rootSourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000112",
        action: "tombstone",
      }),
    );

    const insertMany = vi.fn(async () => ({ successes: [], failures: [] }));
    setSourceServiceOverride({ insertMany });
    try {
      await expect(
        insertNewSources({
          db: database,
          userId,
          parentSourceType: "meeting_transcript",
          parentSourceId: "tombstoned-transcript",
          childSourceType: "conversation_message",
          childSources: [
            {
              externalId: "tombstoned-transcript:0",
              timestamp: new Date(),
              content: "private child turn",
            },
          ],
          parentWriteFence: {
            sourceId: rootSourceId,
            expectedSourceVersion: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "SOURCE_TOMBSTONED" });
      expect(insertMany).not.toHaveBeenCalled();
    } finally {
      resetTestOverrides();
    }
  });

  it("rejects a metric event after its source precheck is overtaken by tombstone", async () => {
    const userId = "source-write-fence-metric-event-race";
    const sourceId = newTypeId("source");
    const definitionId = newTypeId("metric_definition");
    const commandId = "00000000-0000-4000-8000-000000000114";
    await database.insert(schema.users).values({ id: userId });
    await database.insert(schema.sources).values({
      id: sourceId,
      userId,
      type: "metric_push",
      externalId: "metric-event-race",
      status: "completed",
    });
    await database.insert(schema.metricDefinitions).values({
      id: definitionId,
      userId,
      slug: "event_race_metric",
      label: "Event race metric",
      description: "Guards metric event creation against source deletion",
      unit: "count",
      aggregationHint: "sum",
    });

    vi.resetModules();
    let precheckCompleted = false;
    vi.doMock("~/lib/partition-access", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("~/lib/partition-access")>();
      return {
        ...actual,
        withSourceWriteFence: async <T>(
          db: typeof database,
          input: Parameters<typeof actual.withSourceWriteFence>[1],
          write: Parameters<typeof actual.withSourceWriteFence<T>>[2],
        ): Promise<T> => {
          const result = await actual.withSourceWriteFence(db, input, write);
          if (!precheckCompleted) {
            precheckCompleted = true;
            await applySourceLifecycleCommand(
              database,
              sourceLifecycleCommandRequestSchema.parse({
                userId,
                sourceId,
                expectedPartitionKey: null,
                expectedSourceVersion: 0,
                commandId,
                action: "tombstone",
              }),
            );
          }
          return result;
        },
      };
    });

    try {
      const { recordMetricObservations } = await import(
        "~/lib/metrics/observations"
      );
      await expect(
        recordMetricObservations(
          {
            userId,
            sourceId,
            createDefinitions: false,
            deleteExistingForSource: false,
            events: [
              {
                eventKey: "race-event",
                label: "Must not be created",
                occurredAt: new Date("2026-07-16T12:00:00.000Z"),
                observations: [
                  {
                    metricSlug: "event_race_metric",
                    value: 1,
                  },
                ],
              },
            ],
            observations: [],
          },
          database,
        ),
      ).resolves.toMatchObject({
        inserted: 0,
        observations: [],
        errors: [
          expect.objectContaining({
            code: "INVALID_INPUT",
            message: expect.stringContaining("tombstoned"),
          }),
        ],
      });
    } finally {
      vi.doUnmock("~/lib/partition-access");
      vi.resetModules();
    }

    expect(precheckCompleted).toBe(true);
    await expect(
      database
        .select()
        .from(schema.nodeMetadata)
        .where(
          sql`${schema.nodeMetadata.additionalData} ->> 'metricEventKey' = ${`${sourceId}:race-event`}`,
        ),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.sourceLinks)
        .where(eq(schema.sourceLinks.sourceId, sourceId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.metricObservations)
        .where(eq(schema.metricObservations.sourceId, sourceId)),
    ).resolves.toEqual([]);
    const [source] = await database
      .select({ deletedAt: schema.sources.deletedAt })
      .from(schema.sources)
      .where(eq(schema.sources.id, sourceId));
    expect(source?.deletedAt).toBeInstanceOf(Date);
  });

  it("scrubs shared-node read, alias, and embedding projections when one linked source is erased", async () => {
    const userId = "source-write-fence-shared-node-user";
    const deletedSourceId = newTypeId("source");
    const liveSourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    await database.insert(schema.users).values({ id: userId });
    await database.insert(schema.sources).values([
      {
        id: deletedSourceId,
        userId,
        type: "document",
        externalId: "secret-source",
        metadata: { rawContent: "secret deleted-source text" },
      },
      {
        id: liveSourceId,
        userId,
        type: "document",
        externalId: "live-source",
      },
    ]);
    await database.insert(schema.nodes).values({
      id: nodeId,
      userId,
      nodeType: "Object",
    });
    await database.insert(schema.nodeMetadata).values({
      nodeId,
      label: "secret deleted-source text",
      description: "secret deleted-source description",
    });
    await database.insert(schema.aliases).values({
      id: newTypeId("alias"),
      userId,
      aliasText: "secret deleted-source alias",
      normalizedAliasText: "secret deleted-source alias",
      canonicalNodeId: nodeId,
    });
    await database.execute(sql`
      INSERT INTO node_embeddings (id, node_id, embedding, model_name)
      VALUES (${newTypeId("node_embedding")}, ${nodeId}, ${`[${Array(1024).fill(0).join(",")}]`}::vector, 'test')
    `);
    await database.insert(schema.sourceLinks).values([
      { sourceId: deletedSourceId, nodeId },
      { sourceId: liveSourceId, nodeId },
    ]);

    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: deletedSourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000113",
        action: "tombstone",
      }),
    );

    await expect(
      database
        .select()
        .from(schema.nodeMetadata)
        .where(eq(schema.nodeMetadata.nodeId, nodeId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.aliases)
        .where(eq(schema.aliases.canonicalNodeId, nodeId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.nodeEmbeddings)
        .where(eq(schema.nodeEmbeddings.nodeId, nodeId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select()
        .from(schema.sourceLinks)
        .where(eq(schema.sourceLinks.sourceId, liveSourceId)),
    ).resolves.toHaveLength(1);
  });
});
