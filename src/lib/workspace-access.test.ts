import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  claims,
  memoryPartitions,
  nodeMetadata,
  nodes,
  partitionMigrationState,
  sourceIngestionOperations,
  sources,
  users,
} from "~/db/schema";
import {
  getWorkspaceAssistantAtlasNodeIds,
  getWorkspaceAtlasEntries,
} from "~/lib/atlas";
import { assembleAtlasSection } from "~/lib/context/sections/atlas";
import {
  getSourceIngestionOperationById,
  resolveSourceProcessingPartition,
} from "~/lib/ingestion/source-processing";
import {
  ensurePersonalPartition,
  partitionAccessCondition,
} from "~/lib/partition-access";
import { resolveCitations } from "~/lib/resolve-citations";
import {
  contextPartitionKeySchema,
  MEMORY_PERSONAL_PARTITION_KEY,
} from "~/lib/schemas/partition";
import { newTypeId } from "~/types/typeid";

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

describeIfServer("workspace partition access", () => {
  const dbName = `memory_workspace_access_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const userId = "workspace-access-user";
  const otherUserId = "workspace-access-other";
  const legacyUserId = "workspace-access-legacy";
  const migratingUserId = "workspace-access-migrating";
  const partitionA = contextPartitionKeySchema.parse("room:a");
  const partitionB = contextPartitionKeySchema.parse("room:b");
  const quarantined = contextPartitionKeySchema.parse("room:quarantined");
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

    await database
      .insert(users)
      .values([
        { id: userId },
        { id: otherUserId },
        { id: legacyUserId },
        { id: migratingUserId },
      ]);
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA, status: "active" },
      { userId, partitionKey: partitionB, status: "active" },
      { userId, partitionKey: quarantined, status: "quarantined" },
      { userId: otherUserId, partitionKey: partitionA, status: "active" },
    ]);
    await database.insert(schema.partitionMigrationState).values({
      userId,
      state: "migrated",
      version: 1,
    });
    await database.insert(schema.partitionMigrationState).values({
      userId: otherUserId,
      state: "migrated",
      version: 1,
    });
    await database.insert(schema.partitionMigrationState).values({
      userId: migratingUserId,
      state: "migrating",
      version: 1,
    });

    const rows = [
      { userId, partitionKey: partitionA, label: "A" },
      { userId, partitionKey: partitionB, label: "B" },
      { userId: otherUserId, partitionKey: partitionA, label: "other" },
      { userId: legacyUserId, partitionKey: null, label: "legacy" },
    ];
    for (const row of rows) {
      const nodeId = newTypeId("node");
      await database.insert(nodes).values({
        id: nodeId,
        userId: row.userId,
        partitionKey: row.partitionKey ?? undefined,
        nodeType: "Person",
      });
      await database.insert(nodeMetadata).values({
        id: newTypeId("node_metadata"),
        nodeId,
        label: row.label,
        canonicalLabel: row.label.toLowerCase(),
      });
    }
  }, 60_000);

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

  it("returns only active partitions for the requested user", async () => {
    const rows = await database
      .select({ userId: nodes.userId, label: nodeMetadata.label })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            undefined,
            "workspace",
          ),
        ),
      )
      .orderBy(nodeMetadata.label);

    expect(rows).toEqual([
      { userId, label: "A" },
      { userId, label: "B" },
    ]);

    await expect(
      database
        .select({ label: nodeMetadata.label })
        .from(nodes)
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(
            eq(nodes.userId, legacyUserId),
            partitionAccessCondition(
              nodes.partitionKey,
              legacyUserId,
              undefined,
              "workspace",
            ),
          ),
        ),
    ).resolves.toEqual([{ label: "legacy" }]);
  });

  it("does not broaden an explicit partition or strict legacy call", async () => {
    const scoped = await database
      .select({ label: nodeMetadata.label })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            partitionA,
            "workspace",
          ),
        ),
      );
    expect(scoped).toEqual([{ label: "A" }]);

    const strict = await database
      .select({ label: nodeMetadata.label })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          partitionAccessCondition(nodes.partitionKey, userId, undefined),
        ),
      );
    expect(strict).toEqual([]);
  });

  it("creates the Memory-owned personal destination only for migrated users", async () => {
    await expect(ensurePersonalPartition(database, userId)).resolves.toBe(
      "memory:personal",
    );
    await expect(
      database
        .select({ status: memoryPartitions.status })
        .from(memoryPartitions)
        .where(
          and(
            eq(memoryPartitions.userId, userId),
            eq(memoryPartitions.partitionKey, MEMORY_PERSONAL_PARTITION_KEY),
          ),
        ),
    ).resolves.toEqual([{ status: "active" }]);

    await expect(ensurePersonalPartition(database, legacyUserId)).resolves.toBe(
      undefined,
    );
    await expect(
      ensurePersonalPartition(database, migratingUserId),
    ).resolves.toBe(undefined);
  });

  it("aggregates active atlas and citation data without crossing partitions", async () => {
    const assistantId = "assistant-workspace-test";
    const atlasA = newTypeId("node");
    const atlasB = newTypeId("node");
    const atlasQuarantined = newTypeId("node");
    const atlasForeign = newTypeId("node");
    const assistantAtlasA = newTypeId("node");
    const assistantAtlasB = newTypeId("node");
    const relatedA = newTypeId("node");
    const relatedB = newTypeId("node");
    const legacyRelated = newTypeId("node");
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const legacySource = newTypeId("source");
    const claimA = newTypeId("claim");
    const claimB = newTypeId("claim");
    const inactiveClaim = newTypeId("claim");

    await database.insert(nodes).values([
      { id: atlasA, userId, partitionKey: partitionA, nodeType: "Atlas" },
      { id: atlasB, userId, partitionKey: partitionB, nodeType: "Atlas" },
      {
        id: atlasForeign,
        userId: otherUserId,
        partitionKey: partitionA,
        nodeType: "Atlas",
      },
      {
        id: assistantAtlasA,
        userId,
        partitionKey: partitionA,
        nodeType: "Atlas",
      },
      {
        id: assistantAtlasB,
        userId,
        partitionKey: partitionB,
        nodeType: "Atlas",
      },
      { id: relatedA, userId, partitionKey: partitionA, nodeType: "Object" },
      { id: relatedB, userId, partitionKey: partitionB, nodeType: "Object" },
      {
        id: legacyRelated,
        userId,
        partitionKey: partitionA,
        nodeType: "Object",
      },
    ]);
    // The production trigger prevents new rows from entering quarantine. A
    // quarantined row can still exist while an incident is being isolated;
    // seed that historical state with a test-only trigger bypass.
    await client.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await database.insert(nodes).values({
        id: atlasQuarantined,
        userId,
        partitionKey: quarantined,
        nodeType: "Atlas",
      });
    } finally {
      await client.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }
    await database.insert(nodeMetadata).values([
      { nodeId: atlasA, label: "Atlas", description: "user memory A" },
      { nodeId: atlasB, label: "Atlas", description: "user memory B" },
      {
        nodeId: atlasQuarantined,
        label: "Atlas",
        description: "quarantined memory",
      },
      { nodeId: atlasForeign, label: "Atlas", description: "foreign memory" },
      {
        nodeId: assistantAtlasA,
        label: assistantId,
        description: "assistant memory A",
      },
      {
        nodeId: assistantAtlasB,
        label: assistantId,
        description: "assistant memory B",
      },
      { nodeId: relatedA, label: "Related A" },
      { nodeId: relatedB, label: "Related B" },
      { nodeId: legacyRelated, label: "Legacy related" },
    ]);
    await database.insert(sources).values([
      {
        id: sourceA,
        userId,
        type: "manual",
        externalId: "workspace-atlas-source-a",
        partitionKey: partitionA,
        metadata: { title: "Source A" },
      },
      {
        id: sourceB,
        userId,
        type: "manual",
        externalId: "workspace-atlas-source-b",
        partitionKey: partitionB,
        metadata: { title: "Source B" },
      },
      {
        id: legacySource,
        userId,
        type: "manual",
        externalId: "workspace-atlas-source-inactive",
        partitionKey: partitionA,
        metadata: { title: "Do not expose" },
      },
    ]);
    await database.insert(claims).values([
      {
        id: claimA,
        userId,
        partitionKey: partitionA,
        subjectNodeId: assistantAtlasA,
        objectNodeId: relatedA,
        predicate: "OWNS",
        statement: "Assistant atlas A owns related A",
        sourceId: sourceA,
        assertedByKind: "system",
        statedAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: claimB,
        userId,
        partitionKey: partitionB,
        subjectNodeId: assistantAtlasB,
        objectNodeId: relatedB,
        predicate: "OWNS",
        statement: "Assistant atlas B owns related B",
        sourceId: sourceB,
        assertedByKind: "system",
        statedAt: new Date("2026-01-02T00:00:00Z"),
      },
      {
        id: inactiveClaim,
        userId,
        partitionKey: partitionA,
        subjectNodeId: legacyRelated,
        objectValue: "inactive",
        predicate: "HAS_STATUS",
        statement: "Do not expose",
        sourceId: legacySource,
        assertedByKind: "system",
        status: "superseded",
        statedAt: new Date("2026-01-03T00:00:00Z"),
      },
    ]);

    const atlases = await getWorkspaceAtlasEntries(
      database,
      userId,
      assistantId,
    );
    expect(atlases.user.map((row) => row.description)).toEqual([
      "user memory A",
      "user memory B",
    ]);
    await expect(
      assembleAtlasSection(database, userId, undefined, "workspace"),
    ).resolves.toMatchObject({
      content: expect.stringContaining("user memory A"),
    });
    const workspaceAtlas = await assembleAtlasSection(
      database,
      userId,
      undefined,
      "workspace",
    );
    expect(workspaceAtlas?.content).toContain("user memory B");
    expect(workspaceAtlas?.content).not.toContain("quarantined memory");
    expect(workspaceAtlas?.content).not.toContain("foreign memory");
    expect(atlases.assistant.map((row) => row.description)).toEqual([
      "assistant memory A",
      "assistant memory B",
    ]);

    await expect(
      getWorkspaceAssistantAtlasNodeIds(database, userId, assistantId),
    ).resolves.toEqual(expect.arrayContaining([relatedA, relatedB]));

    const citations = await resolveCitations(
      database,
      userId,
      [claimA, claimB, inactiveClaim],
      undefined,
      "workspace",
    );
    expect(citations.map((citation) => citation.requestedId)).toEqual([
      claimA,
      claimB,
      inactiveClaim,
    ]);
    expect(citations[2]).toMatchObject({
      available: false,
      title: null,
      snippet: null,
      source: null,
      subjectNodeId: null,
    });

    const scopedCitations = await resolveCitations(
      database,
      userId,
      [claimA, claimB],
      partitionA,
      "workspace",
    );
    expect(scopedCitations).toHaveLength(2);
    expect(scopedCitations[0]?.available).toBe(true);
    expect(scopedCitations[1]).toMatchObject({
      available: false,
      canonicalId: null,
      title: null,
    });

    const dayA = newTypeId("node");
    const dayB = newTypeId("node");
    const memoryA = newTypeId("node");
    const memoryB = newTypeId("node");
    await database.insert(nodes).values([
      { id: dayA, userId, partitionKey: partitionA, nodeType: "Temporal" },
      { id: dayB, userId, partitionKey: partitionB, nodeType: "Temporal" },
      { id: memoryA, userId, partitionKey: partitionA, nodeType: "Person" },
      { id: memoryB, userId, partitionKey: partitionB, nodeType: "Person" },
    ]);
    await database.insert(nodeMetadata).values([
      { id: newTypeId("node_metadata"), nodeId: dayA, label: "2026-04-30" },
      { id: newTypeId("node_metadata"), nodeId: dayB, label: "2026-04-30" },
      { id: newTypeId("node_metadata"), nodeId: memoryA, label: "Memory A" },
      { id: newTypeId("node_metadata"), nodeId: memoryB, label: "Memory B" },
    ]);
    await database.insert(claims).values([
      {
        id: newTypeId("claim"),
        userId,
        partitionKey: partitionA,
        subjectNodeId: memoryA,
        objectNodeId: dayA,
        predicate: "OCCURRED_ON",
        statement: "Memory A occurred on 2026-04-30.",
        sourceId: sourceA,
        assertedByKind: "user",
        statedAt: new Date("2026-04-30T10:00:00Z"),
      },
      {
        id: newTypeId("claim"),
        userId,
        partitionKey: partitionB,
        subjectNodeId: memoryB,
        objectNodeId: dayB,
        predicate: "OCCURRED_ON",
        statement: "Memory B occurred on 2026-04-30.",
        sourceId: sourceB,
        assertedByKind: "user",
        statedAt: new Date("2026-04-30T11:00:00Z"),
      },
    ]);
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    const { queryDayMemories } = await import("./query/day");
    await expect(
      queryDayMemories({
        userId,
        date: "2026-04-30",
        includeFormattedResult: false,
        accessScope: "workspace",
      }),
    ).resolves.toMatchObject({
      nodeCount: 2,
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: memoryA }),
        expect.objectContaining({ id: memoryB }),
      ]),
    });
    await expect(
      queryDayMemories({
        userId,
        date: "2026-04-30",
        includeFormattedResult: false,
        partitionKey: partitionA,
        accessScope: "workspace",
      }),
    ).resolves.toMatchObject({
      nodeCount: 1,
      nodes: [expect.objectContaining({ id: memoryA })],
    });
    vi.doUnmock("~/utils/db");

    const migratingSource = newTypeId("source");
    const operationId = `workspace-legacy-operation-${Date.now()}`;
    // Legacy null rows predate migration. Temporarily model that history so
    // the trigger accepts the fixture, then restore the migrating fence.
    await database
      .delete(partitionMigrationState)
      .where(eq(partitionMigrationState.userId, migratingUserId));
    await database.insert(sources).values({
      id: migratingSource,
      userId: migratingUserId,
      type: "document",
      externalId: "workspace-legacy-source",
      metadata: { title: "Migrating legacy source" },
    });
    await database.insert(sourceIngestionOperations).values({
      operationId,
      userId: migratingUserId,
      sourceId: migratingSource,
      externalId: "workspace-legacy-source",
      contentHash: "legacy-hash",
      sourceVersion: 0,
      status: "queued",
      stage: "content",
    });
    await database.insert(partitionMigrationState).values({
      userId: migratingUserId,
      state: "migrating",
      version: 1,
    });
    await expect(
      resolveSourceProcessingPartition({
        db: database,
        userId: migratingUserId,
        operationId,
        accessScope: "workspace",
      }),
    ).resolves.toEqual({ found: true, partitionKey: undefined });
    await expect(
      getSourceIngestionOperationById({
        db: database,
        userId: migratingUserId,
        operationId,
        accessScope: "workspace",
      }),
    ).resolves.toMatchObject({ operationId, sourceId: migratingSource });
  });
});
