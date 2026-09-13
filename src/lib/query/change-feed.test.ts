import { and, eq, inArray, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  aliases,
  claims,
  commitmentPresentations,
  memoryChangeFeedEvents,
  memoryChangeFeedHeads,
  memoryPartitions,
  metricDefinitions,
  metricDefinitionEmbeddings,
  metricObservations,
  nodeEmbeddings,
  nodeMetadata,
  nodeRedirects,
  partitionArtifactReceipts,
  partitionNodeMappings,
  rollupState,
  partitionMigrationState,
  nodes,
  sourceLinks,
  sourceLifecycleCommands,
  sourcePartitionCommands,
  sourceTombstones,
  sources,
  userProfiles,
  users,
} from "~/db/schema";
import { findSimilarNodes } from "~/lib/graph";
import { listMetrics } from "~/lib/metrics/list";
import {
  upsertMetricManualSource,
  upsertMetricPushSource,
} from "~/lib/metrics/sources";
import { getMetricSummary } from "~/lib/metrics/summary";
import { fetchNodesBySource } from "~/lib/nodes-by-source";
import { resumePartitionNodeRecovery } from "~/lib/partition-artifact-recovery";
import { reclassifySourcePartition } from "~/lib/partition-reclassification";
import { queryChangeFeed } from "~/lib/query/change-feed";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { reclassifySourcePartitionRequestSchema } from "~/lib/schemas/partition";
import { sourceLifecycleCommandRequestSchema } from "~/lib/schemas/source-lifecycle";
import {
  applySourceLifecycleCommand,
  listSourceTreeStorageCleanupIds,
  markSourceTreeStorageCleanupCompleted,
  retryPendingLegacySourceReadModelRetraction,
  retryPendingSourceTombstoneStorageCleanup,
} from "~/lib/source-lifecycle";
import { sourceBlobObjectKey } from "~/lib/sources";
import { getSourceSummary } from "~/lib/sources-read";
import { newTypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";
import { setSemanticSearchSubstringQuery } from "~/utils/test-overrides";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";
process.env["DATABASE_URL"] ??=
  "postgres://postgres:postgres@localhost:5431/postgres";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

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

describeIfServer("lossless lifecycle change feed", () => {
  const dbName = `memory_change_feed_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    setTestDatabase(database);
  }, 120_000);

  afterAll(async () => {
    setTestDatabase(null);
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

  it("freezes throughSequence, drains without duplicates, and covers direct mutations", async () => {
    const userId = "feed-direct-mutations";
    const nodeId = newTypeId("node");
    const taskId = newTypeId("node");
    const sourceId = newTypeId("source");
    const linkId = newTypeId("source_link");
    const claimId = newTypeId("claim");
    await database.insert(users).values({ id: userId });
    await database.insert(nodes).values([
      { id: nodeId, userId, nodeType: "Person" },
      { id: taskId, userId, nodeType: "Task" },
    ]);
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "conversation",
      externalId: "feed-direct",
      status: "completed",
    });
    await database.insert(sourceLinks).values({
      id: linkId,
      sourceId,
      nodeId,
    });
    await database.insert(claims).values({
      id: claimId,
      userId,
      subjectNodeId: taskId,
      predicate: "HAS_TASK_STATUS",
      statement: "pending",
      objectValue: "pending",
      sourceId,
      statedAt: new Date(),
      status: "active",
      scope: "personal",
      assertedByKind: "user",
    });

    const first = await queryChangeFeed({ userId, limit: 2 });
    expect(first.complete).toBe(false);
    expect(first.throughSequence).toBeGreaterThan(0);
    expect(first.nextCursor).not.toBeNull();
    const frozenThrough = first.throughSequence;

    const laterSourceId = newTypeId("source");
    await database.insert(sources).values({
      id: laterSourceId,
      userId,
      type: "document",
      externalId: "feed-later",
      status: "pending",
    });

    const drained = [...first.events];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await queryChangeFeed({ userId, cursor, limit: 2 });
      expect(page.throughSequence).toBe(frozenThrough);
      drained.push(...page.events);
      cursor = page.nextCursor;
      if (page.complete) break;
    }
    expect(new Set(drained.map((event) => event.eventId)).size).toBe(
      drained.length,
    );
    expect(drained.every((event) => event.sequence <= frozenThrough)).toBe(
      true,
    );
    expect(drained.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "node",
        "source",
        "ingestion",
        "provenance",
        "claim",
      ]),
    );

    await database.delete(sources).where(eq(sources.id, sourceId));
    const tombstones = await queryChangeFeed({ userId, limit: 500 });
    const sourceTombstone = tombstones.events.find(
      (event) => event.entityType === "source" && event.action === "tombstone",
    );
    expect(sourceTombstone?.kind).toBe("source");
    expect(sourceTombstone?.entityType).toBe("source");
  });

  it("erases source read models and redacts every historical feed payload without sequence loss", async () => {
    const userId = "feed-source-lifecycle";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    const secret = "do-not-replay-this-source-content";
    await database.insert(users).values({ id: userId });
    await database
      .insert(nodes)
      .values({ id: nodeId, userId, nodeType: "Task" });
    await database.insert(nodeMetadata).values({
      id: newTypeId("node_metadata"),
      nodeId,
      label: "source-derived narrative",
      description: secret,
    });
    await database.insert(userProfiles).values({
      id: newTypeId("user_profile"),
      userId,
      content: secret,
    });
    await database.insert(rollupState).values({ userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "provider-message-should-not-leak",
      metadata: { rawContent: secret, title: "private title" },
      status: "completed",
    });
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId,
      nodeId,
    });
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: nodeId,
      predicate: "HAS_TASK_STATUS",
      statement: secret,
      objectValue: "pending",
      sourceId,
      statedAt: new Date(),
      status: "active",
      scope: "personal",
      assertedByKind: "user",
    });

    const before = await queryChangeFeed({ userId, limit: 500 });
    expect(JSON.stringify(before.events)).toContain(secret);

    const tombstone = await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000001",
        action: "tombstone",
      }),
    );
    expect(tombstone).toMatchObject({
      state: "tombstoned",
      replayed: false,
      freshIngestionRequired: false,
      storageCleanupState: "pending",
    });
    expect(tombstone.sourceVersion).toBe(1);

    const after = await queryChangeFeed({ userId, limit: 500 });
    const sourceEvents = after.events.filter(
      (event) => event.sourceId === sourceId,
    );
    expect(sourceEvents.length).toBeGreaterThan(0);
    expect(
      sourceEvents.every((event) => event.payload["redacted"] === true),
    ).toBe(true);
    expect(sourceEvents.every((event) => event.provenance === null)).toBe(true);
    expect(sourceEvents.every((event) => event.freshness === null)).toBe(true);
    expect(JSON.stringify(after.events)).not.toContain(secret);
    expect(JSON.stringify(after.events)).not.toContain(
      "provider-message-should-not-leak",
    );
    expect(after.events.map((event) => event.sequence)).toEqual(
      [...after.events].map((_, index) => index + 1),
    );

    const [erasedSource] = await database
      .select({ metadata: sources.metadata, deletedAt: sources.deletedAt })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(erasedSource).toEqual({ metadata: {}, deletedAt: expect.any(Date) });
    await expect(
      getSourceSummary(database, userId, sourceId),
    ).resolves.toBeNull();
    const remainingClaims = await database
      .select({ id: claims.id })
      .from(claims)
      .where(eq(claims.sourceId, sourceId));
    const remainingLinks = await database
      .select({ id: sourceLinks.id })
      .from(sourceLinks)
      .where(eq(sourceLinks.sourceId, sourceId));
    expect(remainingClaims).toEqual([]);
    expect(remainingLinks).toEqual([]);
    const removedNode = await database
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    expect(removedNode).toEqual([]);
    await expect(
      database
        .select({ id: userProfiles.id })
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({ userId: rollupState.userId })
        .from(rollupState)
        .where(eq(rollupState.userId, userId)),
    ).resolves.toEqual([]);

    await expect(
      applySourceLifecycleCommand(
        database,
        sourceLifecycleCommandRequestSchema.parse({
          userId,
          sourceId,
          expectedPartitionKey: null,
          expectedSourceVersion: 0,
          commandId: "00000000-0000-4000-8000-000000000001",
          action: "tombstone",
        }),
      ),
    ).resolves.toMatchObject({ replayed: true, state: "tombstoned" });
    await expect(
      applySourceLifecycleCommand(
        database,
        sourceLifecycleCommandRequestSchema.parse({
          userId,
          sourceId,
          expectedPartitionKey: null,
          expectedSourceVersion: 0,
          commandId: "00000000-0000-4000-8000-000000000002",
          action: "tombstone",
        }),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_VERSION_CONFLICT" });

    const restored = await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000003",
        action: "restore",
      }),
    );
    expect(restored).toMatchObject({
      state: "restored",
      freshIngestionRequired: true,
    });
    const oldSource = await database
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(oldSource).toEqual([]);
    const newSourceId = newTypeId("source");
    await database.insert(sources).values({
      id: newSourceId,
      userId,
      type: "document",
      externalId: "provider-message-should-not-leak",
      metadata: { rawContent: "freshly-ingested" },
    });
    const [receipt] = await database
      .select({ state: sourceTombstones.state })
      .from(sourceTombstones)
      .where(eq(sourceTombstones.sourceId, sourceId));
    expect(receipt?.state).toBe("restored");
  });

  it("redacts the old partition replay after a source moves", async () => {
    const userId = "feed-active-partition-move";
    const sourceId = newTypeId("source");
    const partitionA = contextPartitionKeySchema.parse("opaque:feed-a");
    const partitionB = contextPartitionKeySchema.parse("opaque:feed-b");
    const secret = "content-that-must-leave-partition-a";
    await database.insert(users).values({ id: userId });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
    });
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA },
      { userId, partitionKey: partitionB },
    ]);
    await database.insert(sources).values({
      id: sourceId,
      userId,
      partitionKey: partitionA,
      type: "document",
      externalId: "feed-active-move",
      metadata: { rawContent: secret },
      status: "completed",
    });

    const before = await queryChangeFeed({
      userId,
      partitionKey: partitionA,
      limit: 500,
    });
    expect(JSON.stringify(before.events)).toContain(secret);

    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: partitionA,
        targetPartitionKey: partitionB,
        expectedSourceVersion: 0,
        bindingGeneration: "active-feed-move",
      }),
    );

    const after = await queryChangeFeed({
      userId,
      partitionKey: partitionA,
      limit: 500,
    });
    const movedSourceEvents = after.events.filter(
      (event) => event.sourceId === sourceId,
    );
    expect(movedSourceEvents.length).toBeGreaterThan(0);
    expect(
      movedSourceEvents.every((event) => event.payload["redacted"] === true),
    ).toBe(true);
    expect(JSON.stringify(after.events)).not.toContain(secret);
    expect(JSON.stringify(after.events)).not.toContain(partitionB);
  });

  it("locks a large source tree in one ordered query before tombstoning it", async () => {
    const userId = "feed-bulk-tree-lock";
    const rootId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: rootId,
      userId,
      type: "conversation",
      externalId: "bulk-root",
      status: "completed",
    });
    const children = Array.from({ length: 100 }, (_, index) => ({
      id: newTypeId("source"),
      userId,
      parentSource: rootId,
      type: "conversation_message" as const,
      externalId: `bulk-child-${index}`,
      status: "completed" as const,
    }));
    await database.insert(sources).values(children);
    const queries: string[] = [];
    const observedDatabase = drizzle(client, {
      schema,
      casing: "snake_case",
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    await applySourceLifecycleCommand(
      observedDatabase,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: rootId,
        commandId: "00000000-0000-4000-8000-000000000099",
        action: "tombstone",
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
      }),
    );
    const treeLocks = queries.filter(
      (query) =>
        query.includes('from "sources"') && query.endsWith("for update"),
    );
    expect(treeLocks).toHaveLength(1);
    expect(treeLocks[0]).toContain('order by "sources"."id" asc');
    const remaining = await database
      .select({ deletedAt: sources.deletedAt })
      .from(sources)
      .where(eq(sources.userId, userId));
    expect(remaining).toHaveLength(101);
    expect(remaining.every((source) => source.deletedAt !== null)).toBe(true);
    await markSourceTreeStorageCleanupCompleted(database, userId, rootId);
  });

  it("tombstones a parent source and every descendant without touching an unrelated sibling", async () => {
    const userId = "feed-source-tree-lifecycle";
    const parentSourceId = newTypeId("source");
    const childSourceId = newTypeId("source");
    const grandchildSourceId = newTypeId("source");
    const siblingSourceId = newTypeId("source");
    const childNodeId = newTypeId("node");
    const grandchildNodeId = newTypeId("node");
    const siblingNodeId = newTypeId("node");
    const childSecret = "child-message-must-not-survive-erasure";
    const grandchildSecret = "nested-message-must-not-survive-erasure";
    const siblingSecret = "sibling-message-must-stay";
    await database.insert(users).values({ id: userId });
    await database.insert(nodes).values([
      { id: childNodeId, userId, nodeType: "Task" },
      { id: grandchildNodeId, userId, nodeType: "Task" },
      { id: siblingNodeId, userId, nodeType: "Task" },
    ]);
    await database.insert(nodeMetadata).values([
      {
        id: newTypeId("node_metadata"),
        nodeId: childNodeId,
        label: childSecret,
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: grandchildNodeId,
        label: grandchildSecret,
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: siblingNodeId,
        label: siblingSecret,
      },
    ]);
    await database.insert(sources).values([
      {
        id: parentSourceId,
        userId,
        type: "conversation",
        externalId: "parent-conversation",
        metadata: { rawContent: "parent-container-secret" },
        status: "completed",
      },
      {
        id: childSourceId,
        userId,
        type: "conversation_message",
        externalId: "child-message",
        parentSource: parentSourceId,
        metadata: { rawContent: childSecret },
        contentType: "text/plain",
        contentLength: childSecret.length,
        status: "completed",
      },
      {
        id: grandchildSourceId,
        userId,
        type: "conversation_message",
        externalId: "nested-message",
        parentSource: childSourceId,
        metadata: { rawContent: grandchildSecret },
        status: "completed",
      },
      {
        id: siblingSourceId,
        userId,
        type: "document",
        externalId: "unrelated-document",
        metadata: { rawContent: siblingSecret },
        status: "completed",
      },
    ]);
    await database.insert(sourceLinks).values([
      {
        id: newTypeId("source_link"),
        sourceId: childSourceId,
        nodeId: childNodeId,
      },
      {
        id: newTypeId("source_link"),
        sourceId: grandchildSourceId,
        nodeId: grandchildNodeId,
      },
      {
        id: newTypeId("source_link"),
        sourceId: siblingSourceId,
        nodeId: siblingNodeId,
      },
    ]);

    const tombstone = await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: parentSourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000006",
        action: "tombstone",
      }),
    );
    expect(tombstone.storageCleanupState).toBe("pending");
    await expect(
      listSourceTreeStorageCleanupIds(database, userId, parentSourceId),
    ).resolves.toEqual([parentSourceId, childSourceId, grandchildSourceId]);
    await database.insert(sourceLifecycleCommands).values({
      userId,
      commandId: "00000000-0000-4000-8000-000000000008",
      sourceId: childSourceId,
      expectedPartitionKey: null,
      expectedSourceVersion: 0,
      action: "tombstone",
      state: "tombstoned",
      sourceVersion: 1,
      restorableUntil: tombstone.restorableUntil,
      storageCleanupState: "pending",
      storageObjectKeys: [sourceBlobObjectKey(userId, childSourceId)],
    });
    await markSourceTreeStorageCleanupCompleted(
      database,
      userId,
      parentSourceId,
    );
    await expect(
      listSourceTreeStorageCleanupIds(database, userId, parentSourceId),
    ).resolves.toEqual([]);
    const cleanupReceipts = await database
      .select({
        commandId: sourceLifecycleCommands.commandId,
        storageCleanupState: sourceLifecycleCommands.storageCleanupState,
      })
      .from(sourceLifecycleCommands)
      .where(
        inArray(sourceLifecycleCommands.commandId, [
          "00000000-0000-4000-8000-000000000006",
          "00000000-0000-4000-8000-000000000008",
        ]),
      );
    expect(cleanupReceipts).toEqual(
      expect.arrayContaining([
        {
          commandId: "00000000-0000-4000-8000-000000000006",
          storageCleanupState: "completed",
        },
        {
          commandId: "00000000-0000-4000-8000-000000000008",
          storageCleanupState: "completed",
        },
      ]),
    );

    const erasedSources = await database
      .select({
        id: sources.id,
        metadata: sources.metadata,
        deletedAt: sources.deletedAt,
        contentType: sources.contentType,
        contentLength: sources.contentLength,
      })
      .from(sources)
      .where(inArray(sources.id, [childSourceId, grandchildSourceId]));
    expect(erasedSources).toEqual(
      expect.arrayContaining([
        {
          id: childSourceId,
          metadata: {},
          deletedAt: expect.any(Date),
          contentType: null,
          contentLength: null,
        },
        {
          id: grandchildSourceId,
          metadata: {},
          deletedAt: expect.any(Date),
          contentType: null,
          contentLength: null,
        },
      ]),
    );
    await expect(
      getSourceSummary(database, userId, childSourceId),
    ).resolves.toBeNull();
    await expect(
      getSourceSummary(database, userId, grandchildSourceId),
    ).resolves.toBeNull();
    const redactedNodes = await database
      .select({ id: nodes.id })
      .from(nodes)
      .where(inArray(nodes.id, [childNodeId, grandchildNodeId]));
    expect(redactedNodes).toEqual([]);
    const [siblingSource] = await database
      .select({ metadata: sources.metadata, deletedAt: sources.deletedAt })
      .from(sources)
      .where(eq(sources.id, siblingSourceId));
    expect(siblingSource).toEqual({
      metadata: { rawContent: siblingSecret },
      deletedAt: null,
    });
    const [siblingNode] = await database
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.id, siblingNodeId));
    expect(siblingNode).toEqual({ id: siblingNodeId });

    const feed = await queryChangeFeed({ userId, limit: 500 });
    const treeSourceIds = new Set<string>([
      parentSourceId,
      childSourceId,
      grandchildSourceId,
    ]);
    const treeEvents = feed.events.filter(
      (event) => event.sourceId !== null && treeSourceIds.has(event.sourceId),
    );
    expect(treeEvents.length).toBeGreaterThan(0);
    expect(
      treeEvents.every((event) => event.payload["redacted"] === true),
    ).toBe(true);
    expect(JSON.stringify(feed.events)).not.toContain(childSecret);
    expect(JSON.stringify(feed.events)).not.toContain(grandchildSecret);
    expect(JSON.stringify(feed.events)).toContain(siblingSecret);

    const restored = await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: parentSourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000007",
        action: "restore",
      }),
    );
    expect(restored).toMatchObject({
      state: "restored",
      freshIngestionRequired: true,
    });
    const removedTreeRows = await database
      .select({ id: sources.id })
      .from(sources)
      .where(
        inArray(sources.id, [
          parentSourceId,
          childSourceId,
          grandchildSourceId,
        ]),
      );
    expect(removedTreeRows).toEqual([]);
    const receiptRows = await database
      .select({
        sourceId: sourceTombstones.sourceId,
        state: sourceTombstones.state,
      })
      .from(sourceTombstones)
      .where(
        inArray(sourceTombstones.sourceId, [
          parentSourceId,
          childSourceId,
          grandchildSourceId,
        ]),
      );
    expect(receiptRows).toEqual(
      expect.arrayContaining([
        { sourceId: parentSourceId, state: "restored" },
        { sourceId: childSourceId, state: "restored" },
        { sourceId: grandchildSourceId, state: "restored" },
      ]),
    );
  });

  it("retracts claim-only node projections and unsupported metric definitions at tombstone commit", async () => {
    const userId = "feed-claim-metric-erasure";
    const sourceId = newTypeId("source");
    const independentSourceId = newTypeId("source");
    const manualSourceId = newTypeId("source");
    const claimSubjectNodeId = newTypeId("node");
    const claimObjectNodeId = newTypeId("node");
    const claimAsserterNodeId = newTypeId("node");
    const reviewTaskNodeId = newTypeId("node");
    const erasedDefinitionId = newTypeId("metric_definition");
    const supportedDefinitionId = newTypeId("metric_definition");
    const secret = "claim-only source language must not remain searchable";
    const occurredAt = new Date("2026-07-01T00:00:00.000Z");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: sourceId,
        userId,
        type: "document",
        externalId: "claim-metric-erasure-source",
        status: "completed",
      },
      {
        id: independentSourceId,
        userId,
        type: "document",
        externalId: "claim-metric-independent-source",
        status: "completed",
      },
      {
        id: manualSourceId,
        userId,
        type: "manual",
        externalId: "manual:metric-review-task",
        status: "completed",
      },
    ]);
    await database.insert(nodes).values([
      { id: claimSubjectNodeId, userId, nodeType: "Person" },
      { id: claimObjectNodeId, userId, nodeType: "Person" },
      { id: claimAsserterNodeId, userId, nodeType: "Person" },
      { id: reviewTaskNodeId, userId, nodeType: "Task" },
    ]);
    const sourceClaimNodeIds = [
      claimSubjectNodeId,
      claimObjectNodeId,
      claimAsserterNodeId,
    ];
    await database.insert(nodeMetadata).values([
      ...sourceClaimNodeIds.map((nodeId) => ({
        id: newTypeId("node_metadata"),
        nodeId,
        label: secret,
        description: secret,
      })),
      {
        id: newTypeId("node_metadata"),
        nodeId: reviewTaskNodeId,
        label: secret,
        description: secret,
      },
    ]);
    await database.insert(aliases).values(
      sourceClaimNodeIds.map((canonicalNodeId, index) => ({
        id: newTypeId("alias"),
        userId,
        aliasText: `${secret}-${index}`,
        normalizedAliasText: `${secret}-${index}`,
        canonicalNodeId,
      })),
    );
    await database.insert(nodeEmbeddings).values(
      sourceClaimNodeIds.map((nodeId) => ({
        id: newTypeId("node_embedding"),
        nodeId,
        embedding: Array.from({ length: 1024 }, () => 0),
        modelName: "test",
      })),
    );
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: claimSubjectNodeId,
      objectNodeId: claimObjectNodeId,
      predicate: "RELATED_TO",
      statement: secret,
      sourceId,
      scope: "personal",
      assertedByKind: "participant",
      assertedByNodeId: claimAsserterNodeId,
      statedAt: occurredAt,
      status: "active",
    });
    const independentClaims: (typeof claims.$inferInsert)[] =
      sourceClaimNodeIds.map((subjectNodeId) => ({
        id: newTypeId("claim"),
        userId,
        subjectNodeId,
        objectValue: "live independent support",
        predicate: "HAS_ATTRIBUTE",
        statement: "This independent claim keeps the node alive after erasure.",
        sourceId: independentSourceId,
        scope: "personal" as const,
        assertedByKind: "user" as const,
        statedAt: occurredAt,
        status: "active" as const,
      }));
    await database.insert(claims).values(independentClaims);
    // `createNode` makes this generic manual link and status claim when it
    // creates a review task. They must not keep source-derived review content
    // alive after its only metric definition is deleted.
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId: manualSourceId,
      nodeId: reviewTaskNodeId,
    });
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: reviewTaskNodeId,
      objectValue: "pending",
      predicate: "HAS_TASK_STATUS",
      statement: secret,
      sourceId: manualSourceId,
      scope: "personal",
      assertedByKind: "system",
      statedAt: occurredAt,
      status: "active",
    });
    await database.insert(metricDefinitions).values([
      {
        id: erasedDefinitionId,
        userId,
        slug: "erased_source_metric",
        label: secret,
        description: secret,
        unit: "count",
        aggregationHint: "sum",
        reviewTaskNodeId,
      },
      {
        id: supportedDefinitionId,
        userId,
        slug: "independently_supported_metric",
        label: "Independently supported metric",
        description: "Has an observation outside the erased source",
        unit: "count",
        aggregationHint: "sum",
      },
    ]);
    await database.insert(metricDefinitionEmbeddings).values({
      id: newTypeId("metric_definition_embedding"),
      metricDefinitionId: erasedDefinitionId,
      embedding: Array.from({ length: 1024 }, () => 0),
      modelName: "test",
    });
    await database.insert(metricObservations).values([
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: erasedDefinitionId,
        value: "1",
        occurredAt,
        sourceId,
      },
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: supportedDefinitionId,
        value: "1",
        occurredAt,
        sourceId,
      },
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: supportedDefinitionId,
        value: "2",
        occurredAt: new Date("2026-07-02T00:00:00.000Z"),
        sourceId: independentSourceId,
      },
    ]);

    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000035",
        action: "tombstone",
      }),
    );

    await expect(
      Promise.all([
        database.$count(nodes, inArray(nodes.id, sourceClaimNodeIds)),
        database.$count(
          nodeMetadata,
          inArray(nodeMetadata.nodeId, sourceClaimNodeIds),
        ),
        database.$count(
          nodeEmbeddings,
          inArray(nodeEmbeddings.nodeId, sourceClaimNodeIds),
        ),
        database.$count(
          aliases,
          inArray(aliases.canonicalNodeId, sourceClaimNodeIds),
        ),
        database.$count(nodes, eq(nodes.id, reviewTaskNodeId)),
        database.$count(
          sourceLinks,
          and(
            eq(sourceLinks.sourceId, manualSourceId),
            eq(sourceLinks.nodeId, reviewTaskNodeId),
          ),
        ),
        database.$count(
          claims,
          and(
            eq(claims.userId, userId),
            eq(claims.subjectNodeId, reviewTaskNodeId),
          ),
        ),
        database.$count(
          metricDefinitionEmbeddings,
          eq(metricDefinitionEmbeddings.metricDefinitionId, erasedDefinitionId),
        ),
      ]),
    ).resolves.toEqual([3, 0, 0, 0, 0, 0, 0, 0]);
    setSemanticSearchSubstringQuery(secret);
    await expect(findSimilarNodes({ userId, text: secret })).resolves.toEqual(
      [],
    );
    setSemanticSearchSubstringQuery(null);
    await expect(queryChangeFeed({ userId, limit: 500 })).resolves.toEqual(
      expect.objectContaining({
        events: expect.not.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({ statement: secret }),
          }),
        ]),
      }),
    );
    await expect(listMetrics({ userId })).resolves.toEqual([
      expect.objectContaining({
        id: supportedDefinitionId,
        stats: expect.objectContaining({ observationCount: 1, latestValue: 2 }),
      }),
    ]);
    await expect(
      getMetricSummary({ userId, metricId: erasedDefinitionId }),
    ).resolves.toEqual({
      metricId: erasedDefinitionId,
      latest: null,
      windows: { "7d": null, "30d": null, "90d": null },
      trend: null,
    });
  });

  it("serializes independent last-supporting source tombstones per metric definition", async () => {
    const userId = "metric-definition-tombstone-race";
    const firstSourceId = newTypeId("source");
    const secondSourceId = newTypeId("source");
    const definitionId = newTypeId("metric_definition");
    const occurredAt = new Date("2026-07-03T00:00:00.000Z");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: firstSourceId,
        userId,
        type: "document",
        externalId: "metric-race-first",
        status: "completed",
      },
      {
        id: secondSourceId,
        userId,
        type: "document",
        externalId: "metric-race-second",
        status: "completed",
      },
    ]);
    await database.insert(metricDefinitions).values({
      id: definitionId,
      userId,
      slug: "concurrent_last_support",
      label: "Concurrent last support",
      description: "Must disappear after both independent sources are erased.",
      unit: "count",
      aggregationHint: "sum",
    });
    await database.insert(metricDefinitionEmbeddings).values({
      id: newTypeId("metric_definition_embedding"),
      metricDefinitionId: definitionId,
      embedding: Array.from({ length: 1024 }, () => 0),
      modelName: "test",
    });
    await database.insert(metricObservations).values([
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: definitionId,
        value: "1",
        occurredAt,
        sourceId: firstSourceId,
      },
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: definitionId,
        value: "2",
        occurredAt,
        sourceId: secondSourceId,
      },
    ]);

    // The trigger makes both delete statements overlap. Without the
    // definition-row fence, each transaction can observe the other's
    // uncommitted observation and incorrectly retain the now-empty definition.
    await client.query(`
      CREATE FUNCTION source_lifecycle_metric_delete_delay()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_sleep(0.15);
        RETURN OLD;
      END;
      $$;
    `);
    await client.query(`
      CREATE TRIGGER source_lifecycle_metric_delete_delay_trigger
      BEFORE DELETE ON metric_observations
      FOR EACH ROW
      EXECUTE FUNCTION source_lifecycle_metric_delete_delay();
    `);
    const firstClient = new Client({ connectionString: dsnFor(dbName) });
    const secondClient = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    const firstDb = drizzle(firstClient, { schema, casing: "snake_case" });
    const secondDb = drizzle(secondClient, { schema, casing: "snake_case" });
    try {
      await expect(
        Promise.all([
          applySourceLifecycleCommand(
            firstDb,
            sourceLifecycleCommandRequestSchema.parse({
              userId,
              sourceId: firstSourceId,
              expectedPartitionKey: null,
              expectedSourceVersion: 0,
              commandId: "00000000-0000-4000-8000-000000000136",
              action: "tombstone",
            }),
          ),
          applySourceLifecycleCommand(
            secondDb,
            sourceLifecycleCommandRequestSchema.parse({
              userId,
              sourceId: secondSourceId,
              expectedPartitionKey: null,
              expectedSourceVersion: 0,
              commandId: "00000000-0000-4000-8000-000000000137",
              action: "tombstone",
            }),
          ),
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ state: "tombstoned" }),
        expect.objectContaining({ state: "tombstoned" }),
      ]);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
      await client.query(
        "DROP TRIGGER IF EXISTS source_lifecycle_metric_delete_delay_trigger ON metric_observations",
      );
      await client.query(
        "DROP FUNCTION IF EXISTS source_lifecycle_metric_delete_delay()",
      );
    }

    await expect(
      Promise.all([
        database.$count(
          metricDefinitions,
          eq(metricDefinitions.id, definitionId),
        ),
        database.$count(
          metricDefinitionEmbeddings,
          eq(metricDefinitionEmbeddings.metricDefinitionId, definitionId),
        ),
        database.$count(
          metricObservations,
          eq(metricObservations.metricDefinitionId, definitionId),
        ),
      ]),
    ).resolves.toEqual([0, 0, 0]);
  });

  it("removes partition replacement recovery and copied projections with its source", async () => {
    const userId = "feed-partitioned-source-tombstone";
    const sourceId = newTypeId("source");
    const supportingSourceId = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const sourcePartition = contextPartitionKeySchema.parse("opaque:source");
    const targetPartition = contextPartitionKeySchema.parse("opaque:target");
    const copiedLabel = "must-not-survive-partition-replacement";
    await database.insert(users).values({ id: userId });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
      version: 1,
    });
    await database.insert(memoryPartitions).values({
      userId,
      partitionKey: sourcePartition,
      status: "active",
    });
    await database.insert(nodes).values({
      id: sourceNodeId,
      userId,
      nodeType: "Task",
      partitionKey: sourcePartition,
    });
    await database.insert(nodeMetadata).values({
      id: newTypeId("node_metadata"),
      nodeId: sourceNodeId,
      label: copiedLabel,
    });
    await database.insert(sources).values([
      {
        id: sourceId,
        userId,
        type: "document",
        externalId: "partitioned-source-to-delete",
        partitionKey: sourcePartition,
      },
      {
        id: supportingSourceId,
        userId,
        type: "document",
        externalId: "partitioned-source-to-keep",
        partitionKey: sourcePartition,
      },
    ]);
    await database.insert(sourceLinks).values([
      {
        id: newTypeId("source_link"),
        sourceId,
        nodeId: sourceNodeId,
      },
      {
        id: newTypeId("source_link"),
        sourceId: supportingSourceId,
        nodeId: sourceNodeId,
      },
    ]);
    const moveRequest = reclassifySourcePartitionRequestSchema.parse({
      userId,
      sourceId,
      expectedPartitionKey: sourcePartition,
      targetPartitionKey: targetPartition,
      expectedSourceVersion: 0,
      bindingGeneration: "delete-partition-replacement",
    });
    const move = await reclassifySourcePartition(database, moveRequest);
    const replacementNodeId = move.nodeMappings[0]?.replacementNodeId;
    expect(replacementNodeId).toBeDefined();
    if (!replacementNodeId) throw new Error("Expected a replacement node");

    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: targetPartition,
        expectedSourceVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000032",
        action: "tombstone",
      }),
    );

    await expect(
      database
        .select({ sourceNodeId: partitionNodeMappings.sourceNodeId })
        .from(partitionNodeMappings)
        .where(eq(partitionNodeMappings.userId, userId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({ sourceNodeId: partitionArtifactReceipts.sourceNodeId })
        .from(partitionArtifactReceipts)
        .where(eq(partitionArtifactReceipts.userId, userId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({
          bindingGeneration: sourcePartitionCommands.bindingGeneration,
        })
        .from(sourcePartitionCommands)
        .where(eq(sourcePartitionCommands.userId, userId)),
    ).resolves.toEqual([]);
    await expect(
      database
        .select({ id: nodes.id })
        .from(nodes)
        .where(eq(nodes.id, replacementNodeId)),
    ).resolves.toEqual([]);
    // The original still has direct support from an unrelated source, but its
    // label was copied into the deleted source's replacement and is no longer
    // safely attributable. It must be rebuilt from live evidence.
    await expect(
      database
        .select({ nodeId: nodeMetadata.nodeId })
        .from(nodeMetadata)
        .where(eq(nodeMetadata.nodeId, sourceNodeId)),
    ).resolves.toEqual([]);
    await expect(
      resumePartitionNodeRecovery(database, {
        userId,
        sourceNodeId,
        partitionKey: targetPartition,
      }),
    ).rejects.toThrow("No partition recovery");
    await expect(
      reclassifySourcePartition(database, moveRequest),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  it("purges a root source tree while retaining only descendant lifecycle receipts", async () => {
    const userId = "feed-source-tree-purge";
    const parentSourceId = newTypeId("source");
    const childSourceId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: parentSourceId,
        userId,
        type: "meeting_transcript",
        externalId: "tree-purge-parent",
        metadata: { rawContent: "parent" },
      },
      {
        id: childSourceId,
        userId,
        type: "conversation_message",
        externalId: "tree-purge-child",
        parentSource: parentSourceId,
        metadata: { rawContent: "child" },
      },
    ]);
    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: parentSourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000008",
        action: "tombstone",
      }),
    );
    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId: parentSourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000009",
        action: "purge",
      }),
    );
    const treeRows = await database
      .select({ id: sources.id })
      .from(sources)
      .where(inArray(sources.id, [parentSourceId, childSourceId]));
    expect(treeRows).toEqual([]);
    const receipts = await database
      .select({
        sourceId: sourceTombstones.sourceId,
        state: sourceTombstones.state,
      })
      .from(sourceTombstones)
      .where(
        inArray(sourceTombstones.sourceId, [parentSourceId, childSourceId]),
      );
    expect(receipts).toEqual(
      expect.arrayContaining([
        { sourceId: parentSourceId, state: "purged" },
        { sourceId: childSourceId, state: "purged" },
      ]),
    );
  });

  it("purges the blank tombstoned source while retaining only its non-content receipt", async () => {
    const userId = "feed-source-purge";
    const sourceId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "purge-me",
      metadata: { rawContent: "private" },
    });
    await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 0,
        commandId: "00000000-0000-4000-8000-000000000004",
        action: "tombstone",
      }),
    );
    const purged = await applySourceLifecycleCommand(
      database,
      sourceLifecycleCommandRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        expectedSourceVersion: 1,
        commandId: "00000000-0000-4000-8000-000000000005",
        action: "purge",
      }),
    );
    expect(purged).toMatchObject({ state: "purged", sourceVersion: null });
    const sourceRows = await database
      .select()
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(sourceRows).toEqual([]);
    const [receipt] = await database
      .select({
        state: sourceTombstones.state,
        restorableUntil: sourceTombstones.restorableUntil,
      })
      .from(sourceTombstones)
      .where(eq(sourceTombstones.sourceId, sourceId));
    expect(receipt).toEqual({ state: "purged", restorableUntil: null });
  });

  it("keeps feed heads distinct for delimiter-bearing user and partition tuples", async () => {
    const unpartitionedUserId = "feed-hash-user|partition";
    const partitionedUserId = "feed-hash-user";
    const partitionKey = contextPartitionKeySchema.parse("partition");
    await database
      .insert(users)
      .values([{ id: unpartitionedUserId }, { id: partitionedUserId }]);
    await database.insert(memoryPartitions).values({
      userId: partitionedUserId,
      partitionKey,
    });
    await database.insert(partitionMigrationState).values({
      userId: partitionedUserId,
      state: "migrating",
      version: 1,
    });
    await database.insert(sources).values([
      {
        id: newTypeId("source"),
        userId: unpartitionedUserId,
        type: "document",
        externalId: "hash-unpartitioned",
      },
      {
        id: newTypeId("source"),
        userId: partitionedUserId,
        partitionKey,
        type: "document",
        externalId: "hash-partitioned",
      },
    ]);
    const heads = await database
      .select({ id: memoryChangeFeedHeads.id })
      .from(memoryChangeFeedHeads)
      .where(eq(memoryChangeFeedHeads.userId, unpartitionedUserId));
    const partitionedHeads = await database
      .select({ id: memoryChangeFeedHeads.id })
      .from(memoryChangeFeedHeads)
      .where(eq(memoryChangeFeedHeads.userId, partitionedUserId));
    expect(heads).toHaveLength(1);
    expect(partitionedHeads).toHaveLength(1);
    expect(heads[0]?.id).not.toBe(partitionedHeads[0]?.id);
  });

  it("keeps source-link cascades user-scoped when an owner is deleted", async () => {
    const userId = "feed-cascade-owner";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "cascade-source",
    });
    await database.insert(nodes).values({
      id: nodeId,
      userId,
      nodeType: "Person",
    });
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId,
      nodeId,
    });
    await expect(
      database.delete(sources).where(eq(sources.id, sourceId)),
    ).resolves.toBeDefined();
    await expect(
      database.delete(nodes).where(eq(nodes.id, nodeId)),
    ).resolves.toBeDefined();

    const secondSourceId = newTypeId("source");
    const secondNodeId = newTypeId("node");
    await database.insert(sources).values({
      id: secondSourceId,
      userId,
      type: "document",
      externalId: "cascade-source-reverse",
    });
    await database.insert(nodes).values({
      id: secondNodeId,
      userId,
      nodeType: "Person",
    });
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId: secondSourceId,
      nodeId: secondNodeId,
    });
    await expect(
      database.delete(nodes).where(eq(nodes.id, secondNodeId)),
    ).resolves.toBeDefined();
    await expect(
      database.delete(sources).where(eq(sources.id, secondSourceId)),
    ).resolves.toBeDefined();
  });

  it("emits old-partition tombstones and new snapshots atomically", async () => {
    const userId = "feed-reclassification";
    const sourceId = newTypeId("source");
    const partitionKey = contextPartitionKeySchema.parse("room:feed");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "reclassify-feed",
      status: "pending",
    });
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
      version: 1,
    });
    await database
      .update(sources)
      .set({ partitionKey })
      .where(and(eq(sources.id, sourceId), isNull(sources.partitionKey)));

    const newFeed = await queryChangeFeed({ userId, partitionKey, limit: 100 });
    const oldEvents = await database
      .select({ action: memoryChangeFeedEvents.action })
      .from(memoryChangeFeedEvents)
      .where(
        and(
          eq(memoryChangeFeedEvents.userId, userId),
          isNull(memoryChangeFeedEvents.partitionKey),
        ),
      );
    expect(oldEvents.some((event) => event.action === "tombstone")).toBe(true);
    expect(newFeed.events.some((event) => event.action === "snapshot")).toBe(
      true,
    );
    const headRows = await database
      .select({ sequence: memoryChangeFeedHeads.nextSequence })
      .from(memoryChangeFeedHeads)
      .where(eq(memoryChangeFeedHeads.userId, userId));
    expect(headRows).toHaveLength(2);
  });

  it("returns a typed epoch invalidation instead of a partial page", async () => {
    const userId = "feed-epoch-invalid";
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: newTypeId("source"),
      userId,
      type: "document",
      externalId: "epoch-feed",
      status: "pending",
    });
    const first = await queryChangeFeed({ userId, limit: 1 });
    await database
      .update(memoryChangeFeedHeads)
      .set({ feedEpoch: 2, nextSequence: 1 })
      .where(eq(memoryChangeFeedHeads.userId, userId));
    const invalid = await queryChangeFeed({
      userId,
      cursor: first.nextCursor ?? "v1.invalid",
      limit: 1,
    });
    expect(invalid.cursorInvalid?.reason).toBe("epoch_mismatch");
    expect(invalid.events).toEqual([]);
  });

  it("routes shared-node source-link provenance to the target partition", async () => {
    const userId = "feed-shared-node-reclassification";
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const nodeId = newTypeId("node");
    const linkA = newTypeId("source_link");
    const linkB = newTypeId("source_link");
    const partitionKey = contextPartitionKeySchema.parse("room:shared-feed");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      { id: sourceA, userId, type: "document", externalId: "shared-a" },
      { id: sourceB, userId, type: "document", externalId: "shared-b" },
    ]);
    await database.insert(nodes).values({
      id: nodeId,
      userId,
      nodeType: "Person",
    });
    await database.insert(sourceLinks).values([
      { id: linkA, sourceId: sourceA, nodeId },
      { id: linkB, sourceId: sourceB, nodeId },
    ]);
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
      version: 1,
    });

    const move = await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceA,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "shared-feed-move",
      }),
    );
    expect(move.nodeMappings).toHaveLength(1);

    const targetFeed = await queryChangeFeed({
      userId,
      partitionKey,
      limit: 500,
    });
    const targetProvenance = targetFeed.events.filter(
      (event) => event.kind === "provenance",
    );
    expect(
      targetProvenance.some(
        (event) => event.sourceId === sourceA && event.entityId === linkA,
      ),
    ).toBe(true);
    expect(
      targetProvenance.some(
        (event) => event.sourceId === sourceB || event.entityId === linkB,
      ),
    ).toBe(false);

    const oldProvenance = await database
      .select({
        action: memoryChangeFeedEvents.action,
        entityId: memoryChangeFeedEvents.entityId,
        sourceId: memoryChangeFeedEvents.sourceId,
      })
      .from(memoryChangeFeedEvents)
      .where(
        and(
          eq(memoryChangeFeedEvents.userId, userId),
          isNull(memoryChangeFeedEvents.partitionKey),
          eq(memoryChangeFeedEvents.entityType, "source_link"),
        ),
      );
    expect(
      oldProvenance.some(
        (event) =>
          event.entityId === linkA &&
          event.sourceId === sourceA &&
          event.action === "tombstone",
      ),
    ).toBe(true);
    expect(
      targetProvenance.filter(
        (event) => event.entityId === linkA && event.action === "snapshot",
      ),
    ).toHaveLength(1);

    const drained = [...targetFeed.events];
    let cursor = targetFeed.nextCursor;
    while (cursor !== null) {
      const page = await queryChangeFeed({
        userId,
        partitionKey,
        cursor,
        limit: 2,
      });
      drained.push(...page.events);
      cursor = page.nextCursor;
    }
    expect(new Set(drained.map((event) => event.eventId)).size).toBe(
      drained.length,
    );
    expect(drained.map((event) => event.sequence)).toEqual(
      [...drained.map((event) => event.sequence)].sort((a, b) => a - b),
    );
  });

  it("retracts and snapshots redirects when a node changes partition", async () => {
    const userId = "feed-redirect-reclassification";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    const fromNodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse("room:redirect-feed");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "redirect-source",
    });
    await database.insert(nodes).values({
      id: nodeId,
      userId,
      nodeType: "Person",
    });
    await database.insert(nodeRedirects).values({
      userId,
      fromNodeId,
      toNodeId: nodeId,
    });
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId,
      nodeId,
    });
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
      version: 1,
    });

    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "redirect-feed-move",
      }),
    );

    const oldRedirectEvents = await database
      .select({
        action: memoryChangeFeedEvents.action,
        entityId: memoryChangeFeedEvents.entityId,
      })
      .from(memoryChangeFeedEvents)
      .where(
        and(
          eq(memoryChangeFeedEvents.userId, userId),
          isNull(memoryChangeFeedEvents.partitionKey),
          eq(memoryChangeFeedEvents.entityType, "redirect"),
        ),
      );
    expect(
      oldRedirectEvents.some(
        (event) =>
          event.entityId === fromNodeId && event.action === "tombstone",
      ),
    ).toBe(true);

    const targetFeed = await queryChangeFeed({
      userId,
      partitionKey,
      limit: 500,
    });
    const targetRedirectEvents = targetFeed.events.filter(
      (event) => event.entityType === "redirect",
    );
    expect(targetRedirectEvents.map((event) => event.action)).toEqual([
      "snapshot",
    ]);
    expect(targetRedirectEvents[0]?.entityId).toBe(fromNodeId);
  });

  it("retracts source-link provenance across an active partition move", async () => {
    const userId = "feed-active-source-link-reclassification";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    const linkId = newTypeId("source_link");
    const oldPartition = contextPartitionKeySchema.parse("room:old-feed");
    const targetPartition = contextPartitionKeySchema.parse("room:new-feed");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "active-source-link",
      partitionKey: oldPartition,
    });
    await database.insert(nodes).values({
      id: nodeId,
      userId,
      nodeType: "Person",
      partitionKey: oldPartition,
    });
    await database.insert(sourceLinks).values({
      id: linkId,
      sourceId,
      nodeId,
    });
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: oldPartition },
      { userId, partitionKey: targetPartition },
    ]);
    await database.insert(partitionMigrationState).values({
      userId,
      state: "migrating",
      version: 1,
    });

    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: oldPartition,
        targetPartitionKey: targetPartition,
        expectedSourceVersion: 0,
        bindingGeneration: "active-source-link-move",
      }),
    );

    const oldEvents = await database
      .select({ action: memoryChangeFeedEvents.action })
      .from(memoryChangeFeedEvents)
      .where(
        and(
          eq(memoryChangeFeedEvents.userId, userId),
          eq(memoryChangeFeedEvents.partitionKey, oldPartition),
          eq(memoryChangeFeedEvents.entityId, linkId),
        ),
      );
    expect(
      oldEvents.filter((event) => event.action === "tombstone"),
    ).toHaveLength(1);

    const targetFeed = await queryChangeFeed({
      userId,
      partitionKey: targetPartition,
      limit: 500,
    });
    const targetLinks = targetFeed.events.filter(
      (event) =>
        event.entityType === "source_link" && event.entityId === linkId,
    );
    expect(targetLinks.map((event) => event.action)).toEqual(["snapshot"]);
  });

  it("sweeps legacy migrated tombstones after their source rows and command receipts are gone", async () => {
    const userId = "legacy-tombstone-storage-sweep";
    const migratedSourceId = newTypeId("source");
    const interruptedBackfillSourceId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sourceTombstones).values([
      {
        userId,
        sourceId: migratedSourceId,
        partitionKey: null,
        state: "purged",
        erasedAt: new Date("2026-07-01T00:00:00.000Z"),
        finalizedAt: new Date("2026-07-01T00:00:00.000Z"),
        storageCleanupState: "pending",
        // This is the durable object identity captured by 0031 for a 0030
        // tombstone before restore/purge removes the source row.
        storageObjectKey: sourceBlobObjectKey(userId, migratedSourceId),
      },
      {
        userId,
        sourceId: interruptedBackfillSourceId,
        partitionKey: null,
        state: "purged",
        erasedAt: new Date("2026-07-01T00:00:00.000Z"),
        finalizedAt: new Date("2026-07-01T00:00:00.000Z"),
        storageCleanupState: "pending",
        storageObjectKey: null,
      },
    ]);

    const deletedKeys: string[] = [];
    const sweep = await retryPendingSourceTombstoneStorageCleanup(
      database,
      async (objectKey) => {
        deletedKeys.push(objectKey);
      },
      10,
    );
    expect(sweep.attempted).toBeGreaterThanOrEqual(2);
    expect(sweep.completed).toBeGreaterThanOrEqual(2);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([
        sourceBlobObjectKey(userId, migratedSourceId),
        sourceBlobObjectKey(userId, interruptedBackfillSourceId),
      ]),
    );
    const cleanupStates = await database
      .select({
        sourceId: sourceTombstones.sourceId,
        storageCleanupState: sourceTombstones.storageCleanupState,
      })
      .from(sourceTombstones)
      .where(
        and(
          eq(sourceTombstones.userId, userId),
          inArray(sourceTombstones.sourceId, [
            migratedSourceId,
            interruptedBackfillSourceId,
          ]),
        ),
      );
    expect(cleanupStates).toEqual(
      expect.arrayContaining([
        {
          sourceId: migratedSourceId,
          storageCleanupState: "completed",
        },
        {
          sourceId: interruptedBackfillSourceId,
          storageCleanupState: "completed",
        },
      ]),
    );
  });

  it("migrates a legacy soft-delete tree to immediate private retraction before maintenance", async () => {
    const userId = "legacy-read-model-retraction";
    const partitionKey = contextPartitionKeySchema.parse("legacy-room");
    const rootSourceId = newTypeId("source");
    const childSourceId = newTypeId("source");
    const independentSourceId = newTypeId("source");
    const manualSourceId = newTypeId("source");
    const rootNodeId = newTypeId("node");
    const childNodeId = newTypeId("node");
    const claimSubjectNodeId = newTypeId("node");
    const claimObjectNodeId = newTypeId("node");
    const claimAsserterNodeId = newTypeId("node");
    const reviewTaskNodeId = newTypeId("node");
    const replacementNodeId = newTypeId("node");
    const metricDefinitionId = newTypeId("metric_definition");
    const independentlySupportedMetricDefinitionId =
      newTypeId("metric_definition");
    const secret = "legacy source artifact that must disappear";
    const erasedAt = new Date("2026-07-01T00:00:00.000Z");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: rootSourceId,
        userId,
        type: "meeting_transcript",
        externalId: "legacy-root",
        // 0031 already removed descriptors from the deleted root; this test
        // exercises the remaining child-derived projections 0032 must erase.
        metadata: {},
        status: "completed",
      },
      {
        id: childSourceId,
        userId,
        type: "conversation_message",
        externalId: "legacy-root:0",
        parentSource: rootSourceId,
        metadata: { title: secret },
        status: "completed",
      },
      {
        id: independentSourceId,
        userId,
        type: "document",
        externalId: "legacy-independent-metric-source",
        status: "completed",
      },
      {
        id: manualSourceId,
        userId,
        type: "manual",
        externalId: "manual:legacy-metric-review-task",
        status: "completed",
      },
    ]);
    await database.insert(nodes).values([
      { id: rootNodeId, userId, nodeType: "Document" },
      { id: childNodeId, userId, nodeType: "Task" },
      { id: claimSubjectNodeId, userId, nodeType: "Person" },
      { id: claimObjectNodeId, userId, nodeType: "Person" },
      { id: claimAsserterNodeId, userId, nodeType: "Person" },
      { id: reviewTaskNodeId, userId, nodeType: "Task" },
      { id: replacementNodeId, userId, nodeType: "Task" },
    ]);
    const sourceClaimNodeIds = [
      claimSubjectNodeId,
      claimObjectNodeId,
      claimAsserterNodeId,
    ];
    await database.insert(nodeMetadata).values([
      { id: newTypeId("node_metadata"), nodeId: rootNodeId, label: secret },
      { id: newTypeId("node_metadata"), nodeId: childNodeId, label: secret },
      ...sourceClaimNodeIds.map((nodeId) => ({
        id: newTypeId("node_metadata"),
        nodeId,
        label: secret,
        description: secret,
      })),
      {
        id: newTypeId("node_metadata"),
        nodeId: reviewTaskNodeId,
        label: secret,
        description: secret,
      },
    ]);
    await database.insert(aliases).values(
      sourceClaimNodeIds.map((canonicalNodeId, index) => ({
        id: newTypeId("alias"),
        userId,
        aliasText: `${secret}-legacy-${index}`,
        normalizedAliasText: `${secret}-legacy-${index}`,
        canonicalNodeId,
      })),
    );
    await database.insert(nodeEmbeddings).values(
      sourceClaimNodeIds.map((nodeId) => ({
        id: newTypeId("node_embedding"),
        nodeId,
        embedding: Array.from({ length: 1024 }, () => 0),
        modelName: "test",
      })),
    );
    await database.insert(sourceLinks).values([
      {
        id: newTypeId("source_link"),
        sourceId: rootSourceId,
        nodeId: rootNodeId,
      },
      {
        id: newTypeId("source_link"),
        sourceId: childSourceId,
        nodeId: childNodeId,
      },
      {
        id: newTypeId("source_link"),
        sourceId: manualSourceId,
        nodeId: reviewTaskNodeId,
      },
    ]);
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: claimSubjectNodeId,
      objectNodeId: claimObjectNodeId,
      predicate: "RELATED_TO",
      statement: secret,
      sourceId: childSourceId,
      scope: "personal",
      assertedByKind: "participant",
      assertedByNodeId: claimAsserterNodeId,
      statedAt: erasedAt,
      status: "active",
    });
    const independentClaims: (typeof claims.$inferInsert)[] =
      sourceClaimNodeIds.map((subjectNodeId) => ({
        id: newTypeId("claim"),
        userId,
        subjectNodeId,
        objectValue: "live independent support",
        predicate: "HAS_ATTRIBUTE",
        statement: "This independent claim keeps the node alive after erasure.",
        sourceId: independentSourceId,
        scope: "personal" as const,
        assertedByKind: "user" as const,
        statedAt: erasedAt,
        status: "active" as const,
      }));
    await database.insert(claims).values(independentClaims);
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: reviewTaskNodeId,
      objectValue: "pending",
      predicate: "HAS_TASK_STATUS",
      statement: secret,
      sourceId: manualSourceId,
      scope: "personal",
      assertedByKind: "system",
      statedAt: erasedAt,
      status: "active",
    });
    await database.insert(metricDefinitions).values([
      {
        id: metricDefinitionId,
        userId,
        slug: "legacy_retraction_metric",
        label: secret,
        description: secret,
        unit: "count",
        aggregationHint: "sum",
        reviewTaskNodeId,
      },
      {
        id: independentlySupportedMetricDefinitionId,
        userId,
        slug: "legacy_independently_supported_metric",
        label: "Independently supported metric",
        description: "Has evidence outside the deleted legacy tree",
        unit: "count",
        aggregationHint: "sum",
      },
    ]);
    await database.insert(metricDefinitionEmbeddings).values({
      id: newTypeId("metric_definition_embedding"),
      metricDefinitionId,
      embedding: Array.from({ length: 1024 }, () => 0),
      modelName: "test",
    });
    await database.insert(metricObservations).values([
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId,
        value: "1",
        occurredAt: erasedAt,
        sourceId: childSourceId,
      },
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: independentlySupportedMetricDefinitionId,
        value: "1",
        occurredAt: erasedAt,
        sourceId: childSourceId,
      },
      {
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: independentlySupportedMetricDefinitionId,
        value: "2",
        occurredAt: new Date("2026-07-02T00:00:00.000Z"),
        sourceId: independentSourceId,
      },
    ]);
    await database.insert(commitmentPresentations).values({
      taskId: childNodeId,
      userId,
      sourceId: childSourceId,
      excerpt: secret,
    });
    await database.insert(nodeRedirects).values({
      userId,
      fromNodeId: newTypeId("node"),
      toNodeId: childNodeId,
    });
    await database.insert(partitionNodeMappings).values({
      userId,
      sourceNodeId: childNodeId,
      replacementNodeId,
      sourceId: childSourceId,
      partitionKey,
      bindingGeneration: "legacy-source-mapping",
      state: "quarantined",
    });
    await database.insert(partitionArtifactReceipts).values(
      [
        "aliases",
        "node_embeddings",
        "redirects",
        "summary",
        "user_profile",
        "commitment_presentation",
      ].map((artifactKind) => ({
        userId,
        sourceNodeId: childNodeId,
        partitionKey,
        artifactKind: artifactKind as
          | "aliases"
          | "node_embeddings"
          | "redirects"
          | "summary"
          | "user_profile"
          | "commitment_presentation",
        disposition: "rebuilt" as const,
        sourceCount: 1,
        rebuiltCount: 1,
        quarantinedCount: 0,
        details: { legacy: secret },
      })),
    );
    await database
      .update(partitionNodeMappings)
      .set({ state: "completed" })
      .where(
        and(
          eq(partitionNodeMappings.userId, userId),
          eq(partitionNodeMappings.sourceNodeId, childNodeId),
        ),
      );
    const collisionPartitionKey = contextPartitionKeySchema.parse(
      `opaque:${childNodeId}`,
    );
    await database.insert(sourcePartitionCommands).values({
      userId,
      sourceId: independentSourceId,
      bindingGeneration: "unrelated-node-id-in-partition-key",
      expectedPartitionKey: null,
      targetPartitionKey: collisionPartitionKey,
      expectedSourceVersion: 0,
      sourceVersion: 1,
      movedClaimCount: 0,
      nodeMappings: [
        {
          sourceNodeId: newTypeId("node"),
          replacementNodeId: newTypeId("node"),
          partitionKey: collisionPartitionKey,
        },
      ],
    });
    await database.insert(userProfiles).values({
      id: newTypeId("user_profile"),
      userId,
      content: secret,
    });
    await database.insert(rollupState).values({ userId });

    // Reproduce the pre-0030 data shape: evidence already exists, then a
    // soft delete gains only the permanent tombstone authority record.
    await database
      .update(sources)
      .set({ deletedAt: erasedAt })
      .where(eq(sources.id, rootSourceId));
    await database.insert(sourceTombstones).values({
      userId,
      sourceId: rootSourceId,
      partitionKey: null,
      state: "purged",
      erasedAt,
      finalizedAt: erasedAt,
      storageCleanupState: "pending",
      readModelCleanupState: "pending",
    });

    // Run the exact follow-up migration against a pre-existing legacy fixture.
    // The migration transaction is the privacy boundary: no maintenance worker
    // may be required before source, node, or search retrieval becomes safe.
    const migration = await readFile(
      new URL(
        "../../../drizzle/0035_legacy_read_model_retraction.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await client.query("BEGIN");
    try {
      await client.query(migration);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    await expect(
      getSourceSummary(database, userId, childSourceId),
    ).resolves.toBeNull();
    await expect(
      fetchNodesBySource({
        db: database,
        userId,
        sourceIds: [rootSourceId, childSourceId],
        nodeTypes: undefined,
        includeClaims: true,
        limit: 20,
        cursor: undefined,
      }),
    ).resolves.toEqual({ nodes: [], claims: [], nextCursor: null });
    setSemanticSearchSubstringQuery(secret);
    await expect(findSimilarNodes({ userId, text: secret })).resolves.toEqual(
      [],
    );
    setSemanticSearchSubstringQuery(null);
    await expect(listMetrics({ userId })).resolves.toEqual([
      expect.objectContaining({
        id: independentlySupportedMetricDefinitionId,
        stats: expect.objectContaining({ observationCount: 1, latestValue: 2 }),
      }),
    ]);
    await expect(
      getMetricSummary({ userId, metricId: metricDefinitionId }),
    ).resolves.toEqual({
      metricId: metricDefinitionId,
      latest: null,
      windows: { "7d": null, "30d": null, "90d": null },
      trend: null,
    });
    await expect(
      Promise.all([
        database.$count(
          metricDefinitions,
          eq(metricDefinitions.id, metricDefinitionId),
        ),
        database.$count(
          metricDefinitionEmbeddings,
          eq(metricDefinitionEmbeddings.metricDefinitionId, metricDefinitionId),
        ),
        database.$count(nodes, eq(nodes.id, reviewTaskNodeId)),
        database.$count(
          sourceLinks,
          and(
            eq(sourceLinks.sourceId, manualSourceId),
            eq(sourceLinks.nodeId, reviewTaskNodeId),
          ),
        ),
        database.$count(
          claims,
          and(
            eq(claims.userId, userId),
            eq(claims.subjectNodeId, reviewTaskNodeId),
          ),
        ),
        database.$count(nodes, inArray(nodes.id, sourceClaimNodeIds)),
        database.$count(
          nodeMetadata,
          inArray(nodeMetadata.nodeId, sourceClaimNodeIds),
        ),
        database.$count(
          nodeEmbeddings,
          inArray(nodeEmbeddings.nodeId, sourceClaimNodeIds),
        ),
        database.$count(
          aliases,
          inArray(aliases.canonicalNodeId, sourceClaimNodeIds),
        ),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 3, 0, 0, 0]);

    await expect(
      retryPendingLegacySourceReadModelRetraction(database, 10),
    ).resolves.toEqual({ attempted: 0, completed: 0 });
    await expect(
      database.$count(
        sourcePartitionCommands,
        eq(
          sourcePartitionCommands.bindingGeneration,
          "unrelated-node-id-in-partition-key",
        ),
      ),
    ).resolves.toBe(1);
    await expect(
      getSourceSummary(database, userId, childSourceId),
    ).resolves.toBeNull();
    const feed = await queryChangeFeed({ userId, limit: 500 });
    expect(JSON.stringify(feed.events)).not.toContain(secret);
    expect(
      feed.events
        .filter(
          (event) =>
            event.sourceId === rootSourceId || event.sourceId === childSourceId,
        )
        .every((event) => event.payload["redacted"] === true),
    ).toBe(true);
    await expect(
      Promise.all([
        database.$count(
          claims,
          inArray(claims.sourceId, [rootSourceId, childSourceId]),
        ),
        database.$count(
          sourceLinks,
          inArray(sourceLinks.sourceId, [rootSourceId, childSourceId]),
        ),
        database.$count(
          metricObservations,
          eq(metricObservations.sourceId, independentSourceId),
        ),
        database.$count(
          commitmentPresentations,
          inArray(commitmentPresentations.sourceId, [
            rootSourceId,
            childSourceId,
          ]),
        ),
        database.$count(
          partitionNodeMappings,
          eq(partitionNodeMappings.userId, userId),
        ),
        database.$count(
          partitionArtifactReceipts,
          eq(partitionArtifactReceipts.userId, userId),
        ),
        database.$count(nodeRedirects, eq(nodeRedirects.userId, userId)),
        database.$count(userProfiles, eq(userProfiles.userId, userId)),
        database.$count(rollupState, eq(rollupState.userId, userId)),
      ]),
    ).resolves.toEqual([0, 0, 1, 0, 0, 0, 0, 0, 0]);
    await expect(
      database
        .select({
          sourceId: sourceTombstones.sourceId,
          state: sourceTombstones.readModelCleanupState,
        })
        .from(sourceTombstones)
        .where(
          and(
            eq(sourceTombstones.userId, userId),
            inArray(sourceTombstones.sourceId, [rootSourceId, childSourceId]),
          ),
        ),
    ).resolves.toEqual(
      expect.arrayContaining([
        { sourceId: rootSourceId, state: "completed" },
        { sourceId: childSourceId, state: "completed" },
      ]),
    );
    await expect(
      retryPendingLegacySourceReadModelRetraction(database, 10),
    ).resolves.toEqual({ attempted: 0, completed: 0 });
  });

  it("rejects every durable evidence write that directly references a tombstoned source", async () => {
    const userId = "tombstoned-source-reference-guard";
    const sourceId = newTypeId("source");
    const subjectNodeId = newTypeId("node");
    const taskNodeId = newTypeId("node");
    const definitionId = newTypeId("metric_definition");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "tombstoned-reference-guard",
      deletedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    await database.insert(sourceTombstones).values({
      userId,
      sourceId,
      partitionKey: null,
      state: "purged",
      erasedAt: new Date("2026-07-01T00:00:00.000Z"),
      finalizedAt: new Date("2026-07-01T00:00:00.000Z"),
      storageCleanupState: "completed",
    });
    await database.insert(nodes).values([
      { id: subjectNodeId, userId, nodeType: "Person" },
      { id: taskNodeId, userId, nodeType: "Task" },
    ]);
    await database.insert(metricDefinitions).values({
      id: definitionId,
      userId,
      slug: "guarded_metric",
      label: "Guarded metric",
      description: "Only used to prove the source guard",
      unit: "count",
      aggregationHint: "sum",
    });

    await expect(
      database.insert(sourceLinks).values({
        id: newTypeId("source_link"),
        sourceId,
        nodeId: subjectNodeId,
      }),
    ).rejects.toThrow("cannot write evidence for a tombstoned source");
    await expect(
      database.insert(claims).values({
        id: newTypeId("claim"),
        userId,
        subjectNodeId,
        objectValue: "pending",
        predicate: "HAS_TASK_STATUS",
        statement: "This direct write must be rejected",
        sourceId,
        assertedByKind: "user",
        statedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("cannot write evidence for a tombstoned source");
    await expect(
      database.insert(commitmentPresentations).values({
        taskId: taskNodeId,
        userId,
        sourceId,
        excerpt: "must not persist",
      }),
    ).rejects.toThrow("cannot write evidence for a tombstoned source");
    await expect(
      database.insert(metricObservations).values({
        id: newTypeId("metric_observation"),
        userId,
        metricDefinitionId: definitionId,
        value: "1",
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
        sourceId,
      }),
    ).rejects.toThrow("cannot write evidence for a tombstoned source");
  });

  it("keeps source provenance within its owner's evidence while allowing ordinary source links", async () => {
    const sourceOwnerId = "source-reference-owner";
    const otherUserId = "source-reference-other-user";
    const sourceId = newTypeId("source");
    const ownerNodeId = newTypeId("node");
    const otherNodeId = newTypeId("node");
    const otherTaskId = newTypeId("node");
    const otherDefinitionId = newTypeId("metric_definition");
    const ownerLinkId = newTypeId("source_link");

    await database
      .insert(users)
      .values([{ id: sourceOwnerId }, { id: otherUserId }]);
    await database.insert(sources).values({
      id: sourceId,
      userId: sourceOwnerId,
      type: "document",
      externalId: "source-reference-owner-document",
    });
    await database.insert(nodes).values([
      { id: ownerNodeId, userId: sourceOwnerId, nodeType: "Person" },
      { id: otherNodeId, userId: otherUserId, nodeType: "Person" },
      { id: otherTaskId, userId: otherUserId, nodeType: "Task" },
    ]);
    await database.insert(metricDefinitions).values({
      id: otherDefinitionId,
      userId: otherUserId,
      slug: "other_user_metric",
      label: "Other user metric",
      description: "Proves source ownership at the database boundary",
      unit: "count",
      aggregationHint: "sum",
    });

    await expect(
      database.insert(sourceLinks).values({
        id: ownerLinkId,
        sourceId,
        nodeId: ownerNodeId,
      }),
    ).resolves.toBeDefined();

    await expect(
      database
        .update(sourceLinks)
        .set({ nodeId: otherNodeId })
        .where(eq(sourceLinks.id, ownerLinkId)),
    ).rejects.toThrow("source provenance must belong to the same user");

    await expect(
      database.insert(sourceLinks).values({
        id: newTypeId("source_link"),
        sourceId,
        nodeId: otherNodeId,
      }),
    ).rejects.toThrow("source provenance must belong to the same user");
    await expect(
      database.insert(claims).values({
        id: newTypeId("claim"),
        userId: otherUserId,
        subjectNodeId: otherNodeId,
        objectValue: "pending",
        predicate: "HAS_TASK_STATUS",
        statement: "Cross-user provenance must not persist",
        sourceId,
        assertedByKind: "user",
        statedAt: new Date("2026-07-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("source provenance must belong to the same user");
    await expect(
      database.insert(commitmentPresentations).values({
        taskId: otherTaskId,
        userId: otherUserId,
        sourceId,
        excerpt: "Cross-user provenance must not persist",
      }),
    ).rejects.toThrow("source provenance must belong to the same user");
    await expect(
      database.insert(metricObservations).values({
        id: newTypeId("metric_observation"),
        userId: otherUserId,
        metricDefinitionId: otherDefinitionId,
        value: "1",
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
        sourceId,
      }),
    ).rejects.toThrow("source provenance must belong to the same user");
  });

  it("does not let metric push or manual upserts revive tombstoned source identities", async () => {
    const userId = "tombstoned-metric-source-upsert";
    const pushSourceId = newTypeId("source");
    const manualSourceId = newTypeId("source");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: pushSourceId,
        userId,
        type: "metric_push",
        externalId: "deleted-push",
        deletedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        id: manualSourceId,
        userId,
        type: "metric_manual",
        externalId: "deleted-manual",
        deletedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);
    await database.insert(sourceTombstones).values([
      {
        userId,
        sourceId: pushSourceId,
        partitionKey: null,
        state: "purged",
        erasedAt: new Date("2026-07-01T00:00:00.000Z"),
        finalizedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        userId,
        sourceId: manualSourceId,
        partitionKey: null,
        state: "purged",
        erasedAt: new Date("2026-07-01T00:00:00.000Z"),
        finalizedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      upsertMetricPushSource(database, {
        userId,
        externalId: "deleted-push",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_TOMBSTONED" });
    await expect(
      upsertMetricManualSource(database, {
        userId,
        externalId: "deleted-manual",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_TOMBSTONED" });
    const rows = await database
      .select({ id: sources.id, deletedAt: sources.deletedAt })
      .from(sources)
      .where(inArray(sources.id, [pushSourceId, manualSourceId]));
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: pushSourceId, deletedAt: expect.any(Date) },
        { id: manualSourceId, deletedAt: expect.any(Date) },
      ]),
    );
  });

  it("filters malformed claim endpoints when fetching source nodes", async () => {
    const userId = "source-nodes-endpoint-owner";
    const foreignUserId = "source-nodes-endpoint-foreign";
    const sourceId = newTypeId("source");
    const subjectNodeId = newTypeId("node");
    const foreignObjectNodeId = newTypeId("node");
    const validClaimId = newTypeId("claim");
    await database
      .insert(users)
      .values([{ id: userId }, { id: foreignUserId }]);
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "manual",
      externalId: "source-nodes-endpoint",
      scope: "personal",
    });
    await database.insert(nodes).values([
      { id: subjectNodeId, userId, nodeType: "Object" },
      { id: foreignObjectNodeId, userId: foreignUserId, nodeType: "Person" },
    ]);
    await database.insert(nodeMetadata).values([
      {
        id: newTypeId("node_metadata"),
        nodeId: subjectNodeId,
        label: "Owned subject",
        canonicalLabel: "owned subject",
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: foreignObjectNodeId,
        label: "Foreign object",
        canonicalLabel: "foreign object",
      },
    ]);
    await database.insert(sourceLinks).values({
      id: newTypeId("source_link"),
      sourceId,
      nodeId: subjectNodeId,
    });
    await database.insert(claims).values({
      id: validClaimId,
      userId,
      subjectNodeId,
      objectValue: "literal value",
      predicate: "HAS_ATTRIBUTE",
      statement: "Owned subject has a literal value.",
      sourceId,
      scope: "personal",
      assertedByKind: "user",
      statedAt: new Date("2026-09-01T00:00:00Z"),
      status: "active",
    });
    await client.query(`ALTER TABLE "claims" DISABLE TRIGGER USER`);
    try {
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_node_id", "predicate",
           "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
         ) VALUES ($1, $2, $3, $4, 'RELATED_TO',
                   'Owned subject points to a foreign object.', $5, 'personal', 'user', $6, 'active')`,
        [
          newTypeId("claim"),
          userId,
          subjectNodeId,
          foreignObjectNodeId,
          sourceId,
          new Date("2026-09-01T00:00:00Z"),
        ],
      );
    } finally {
      await client.query(`ALTER TABLE "claims" ENABLE TRIGGER USER`);
    }

    const result = await fetchNodesBySource({
      db: database,
      userId,
      sourceIds: [sourceId],
      nodeTypes: undefined,
      includeClaims: true,
      limit: 10,
      cursor: undefined,
    });
    expect(result.nodes.map((node) => node.id)).toEqual([subjectNodeId]);
    expect(result.claims.map((claim) => claim.id)).toEqual([validClaimId]);
    expect(
      result.claims.some((claim) => claim.objectNodeId === foreignObjectNodeId),
    ).toBe(false);
  });
});
