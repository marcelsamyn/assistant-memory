import { and, eq, isNull } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  aliases,
  commitmentPresentations,
  memoryPartitions,
  nodeMetadata,
  nodes,
  nodeRedirects,
  partitionArtifactReceipts,
  partitionNodeMappings,
  rollupState,
  sourceLinks,
  sourcePartitionCommands,
  sources,
  users,
} from "~/db/schema";
import {
  assertSourcePartition,
  type AssertSourcePartitionInput,
} from "~/lib/partition-access";
import {
  resumePartitionNodeRecovery,
  reusePartitionNodeMapping,
} from "~/lib/partition-artifact-recovery";
import {
  getPartitionInventory,
  getPartitionProgress,
} from "~/lib/partition-inventory";
import { setPartitionMigrationState } from "~/lib/partition-migration";
import { reclassifySourcePartition } from "~/lib/partition-reclassification";
import {
  contextPartitionKeySchema,
  reclassifySourcePartitionRequestSchema,
  setPartitionMigrationStateRequestSchema,
} from "~/lib/schemas/partition";
import { newTypeId } from "~/types/typeid";

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
process.env["REDIS_URL"] ??= "redis://localhost:6379";
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

describeIfServer("partition integrity and recovery", () => {
  const dbName = `memory_partition_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function startMigration(userId: string): Promise<void> {
    await setPartitionMigrationState(
      database,
      setPartitionMigrationStateRequestSchema.parse({
        userId,
        expectedState: "unmigrated",
        expectedVersion: 0,
        nextState: "migrating",
      }),
    );
  }

  it("creates a new Memory user with its first migration transition", async () => {
    const userId = "partition-new-user";

    await expect(
      setPartitionMigrationState(
        database,
        setPartitionMigrationStateRequestSchema.parse({
          userId,
          expectedState: "unmigrated",
          expectedVersion: 0,
          nextState: "migrating",
        }),
      ),
    ).resolves.toEqual({ state: "migrating", version: 1 });

    await expect(
      database.select({ id: users.id }).from(users).where(eq(users.id, userId)),
    ).resolves.toEqual([{ id: userId }]);
  });

  it("returns authoritative state when initial migration CAS calls race", async () => {
    const userId = "partition-cas-race";
    await database.insert(users).values({ id: userId });
    const request = setPartitionMigrationStateRequestSchema.parse({
      userId,
      expectedState: "unmigrated",
      expectedVersion: 0,
      nextState: "migrating",
    });
    const results = await Promise.allSettled([
      setPartitionMigrationState(database, request),
      setPartitionMigrationState(database, request),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        code: "MIGRATION_STATE_CONFLICT",
        current: { migrationState: "migrating", migrationVersion: 1 },
      },
    });
  });

  it("manages source versions in the database and detects ABA work", async () => {
    const userId = "partition-source-version";
    const sourceId = newTypeId("source");
    const partitionKey = contextPartitionKeySchema.parse("opaque:versioned");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "versioned",
    });
    await database
      .update(sources)
      .set({ status: "processing" })
      .where(eq(sources.id, sourceId));
    await database
      .update(sources)
      .set({ createdAt: new Date(0) })
      .where(eq(sources.id, sourceId));
    await expect(
      database
        .update(sources)
        .set({ version: 99 })
        .where(eq(sources.id, sourceId)),
    ).rejects.toThrow(/database-managed/);
    await startMigration(userId);
    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 1,
        bindingGeneration: "version-move",
      }),
    );
    const assertion = {
      db: database,
      userId,
      sourceId,
      partitionKey,
      expectedSourceVersion: 1,
    } satisfies AssertSourcePartitionInput;
    await expect(assertSourcePartition(assertion)).rejects.toMatchObject({
      code: "SOURCE_VERSION_CONFLICT",
      currentSourceVersion: 2,
    });
  });

  it("moves aliases and redirects with a sole-supported node", async () => {
    const userId = "partition-dependent-closure";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse(
      "opaque:dependent-closure",
    );
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "dependent-closure",
    });
    await database
      .insert(nodes)
      .values({ id: nodeId, userId, nodeType: "Person" });
    await database.insert(aliases).values({
      id: newTypeId("alias"),
      userId,
      aliasText: "Closure Alias",
      normalizedAliasText: "closure alias",
      canonicalNodeId: nodeId,
    });
    await database.insert(nodeRedirects).values({
      userId,
      fromNodeId: nodeId,
      toNodeId: nodeId,
    });
    await database.insert(sourceLinks).values({ sourceId, nodeId });
    await startMigration(userId);
    await database.insert(memoryPartitions).values({ userId, partitionKey });

    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "dependent-closure",
      }),
    );

    const [node] = await database
      .select({ partitionKey: nodes.partitionKey })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    const [alias] = await database
      .select({ partitionKey: aliases.partitionKey })
      .from(aliases)
      .where(eq(aliases.canonicalNodeId, nodeId));
    const [redirect] = await database
      .select({ partitionKey: nodeRedirects.partitionKey })
      .from(nodeRedirects)
      .where(eq(nodeRedirects.toNodeId, nodeId));
    expect(node?.partitionKey).toBe(partitionKey);
    expect(alias?.partitionKey).toBe(partitionKey);
    expect(redirect?.partitionKey).toBe(partitionKey);
    expect(
      await database.$count(
        aliases,
        and(eq(aliases.userId, userId), isNull(aliases.partitionKey)),
      ),
    ).toBe(0);
    expect(
      await database.$count(
        nodeRedirects,
        and(
          eq(nodeRedirects.userId, userId),
          isNull(nodeRedirects.partitionKey),
        ),
      ),
    ).toBe(0);

    await setPartitionMigrationState(
      database,
      setPartitionMigrationStateRequestSchema.parse({
        userId,
        expectedState: "migrating",
        expectedVersion: 1,
        nextState: "migrated",
        unassignedPartitionKey: "opaque:dependent-unassigned",
      }),
    );
  });

  it("resolves quarantined dependent artifacts when the legacy node later moves", async () => {
    const userId = "partition-dependent-quarantine";
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const nodeId = newTypeId("node");
    const partitionA = contextPartitionKeySchema.parse("opaque:dependent-a");
    const partitionB = contextPartitionKeySchema.parse("opaque:dependent-b");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      { id: sourceA, userId, type: "document", externalId: "dependent-a" },
      { id: sourceB, userId, type: "document", externalId: "dependent-b" },
    ]);
    await database
      .insert(nodes)
      .values({ id: nodeId, userId, nodeType: "Person" });
    await database.insert(aliases).values({
      id: newTypeId("alias"),
      userId,
      aliasText: "Quarantine Alias",
      normalizedAliasText: "quarantine alias",
      canonicalNodeId: nodeId,
    });
    await database.insert(nodeRedirects).values({
      userId,
      fromNodeId: nodeId,
      toNodeId: nodeId,
    });
    await database.insert(sourceLinks).values([
      { sourceId: sourceA, nodeId },
      { sourceId: sourceB, nodeId },
    ]);
    await startMigration(userId);
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA },
      { userId, partitionKey: partitionB },
    ]);

    const first = await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceA,
        expectedPartitionKey: null,
        targetPartitionKey: partitionA,
        expectedSourceVersion: 0,
        bindingGeneration: "dependent-quarantine-a",
      }),
    );
    expect(first.nodeMappings).toHaveLength(1);
    const [quarantinedAliases] = await database
      .select({ disposition: partitionArtifactReceipts.disposition })
      .from(partitionArtifactReceipts)
      .where(
        and(
          eq(partitionArtifactReceipts.userId, userId),
          eq(partitionArtifactReceipts.artifactKind, "aliases"),
        ),
      );
    expect(quarantinedAliases?.disposition).toBe("quarantined");

    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceB,
        expectedPartitionKey: null,
        targetPartitionKey: partitionB,
        expectedSourceVersion: 0,
        bindingGeneration: "dependent-quarantine-b",
      }),
    );
    const [legacyNode] = await database
      .select({ partitionKey: nodes.partitionKey })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    const [alias] = await database
      .select({ partitionKey: aliases.partitionKey })
      .from(aliases)
      .where(eq(aliases.canonicalNodeId, nodeId));
    const [redirect] = await database
      .select({ partitionKey: nodeRedirects.partitionKey })
      .from(nodeRedirects)
      .where(eq(nodeRedirects.toNodeId, nodeId));
    expect(legacyNode?.partitionKey).toBe(partitionB);
    expect(alias?.partitionKey).toBe(partitionB);
    expect(redirect?.partitionKey).toBe(partitionB);
    expect(
      await database.$count(
        aliases,
        and(eq(aliases.userId, userId), isNull(aliases.partitionKey)),
      ),
    ).toBe(0);
    expect(
      await database.$count(
        nodeRedirects,
        and(
          eq(nodeRedirects.userId, userId),
          isNull(nodeRedirects.partitionKey),
        ),
      ),
    ).toBe(0);
  });

  it("moves an invoked child with its parent atomically as one typed command", async () => {
    const userId = "partition-source-tree-atomic";
    const parentId = newTypeId("source");
    const childId = newTypeId("source");
    const siblingId = newTypeId("source");
    const partitionKey = contextPartitionKeySchema.parse("opaque:tree-target");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: parentId,
        userId,
        type: "document",
        externalId: "tree-parent",
      },
      {
        id: childId,
        userId,
        type: "document",
        externalId: "tree-child",
        parentSource: parentId,
      },
      {
        id: siblingId,
        userId,
        type: "document",
        externalId: "tree-sibling",
        parentSource: parentId,
      },
    ]);
    await startMigration(userId);
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await expect(
      database
        .update(sources)
        .set({ partitionKey })
        .where(eq(sources.id, parentId)),
    ).rejects.toThrow(/cross-partition dependents/);
    const [parentBefore] = await database
      .select({ partitionKey: sources.partitionKey, version: sources.version })
      .from(sources)
      .where(eq(sources.id, parentId));
    expect(parentBefore).toMatchObject({ partitionKey: null, version: 0 });

    const moved = await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: childId,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "tree-atomic",
      }),
    );
    const movedSources = await database
      .select({
        id: sources.id,
        partitionKey: sources.partitionKey,
        version: sources.version,
      })
      .from(sources)
      .where(eq(sources.userId, userId));
    expect(movedSources).toHaveLength(3);
    expect(
      movedSources.every((source) => source.partitionKey === partitionKey),
    ).toBe(true);
    expect(movedSources.every((source) => source.version === 1)).toBe(true);
    const [command] = await database
      .select({ sourceIds: sourcePartitionCommands.sourceIds })
      .from(sourcePartitionCommands)
      .where(eq(sourcePartitionCommands.userId, userId));
    expect(command?.sourceIds).toEqual(
      expect.arrayContaining([parentId, childId, siblingId]),
    );
    expect(moved.sourceVersion).toBe(1);
  });

  it("rejects null, inactive, and cross-partition writes after migration starts", async () => {
    const userId = "partition-db-integrity";
    const legacySourceId = newTypeId("source");
    const partitionA = contextPartitionKeySchema.parse("opaque:integrity-a");
    const partitionB = contextPartitionKeySchema.parse("opaque:integrity-b");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: legacySourceId,
      userId,
      type: "document",
      externalId: "legacy",
    });
    await startMigration(userId);
    await expect(
      database.insert(nodes).values({ userId, nodeType: "Person" }),
    ).rejects.toThrow(/requires a partition/);
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA },
      { userId, partitionKey: partitionB },
    ]);
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "partitioned",
      partitionKey: partitionA,
    });
    await database.insert(nodes).values({
      id: nodeId,
      userId,
      nodeType: "Person",
      partitionKey: partitionB,
    });
    await expect(
      database.insert(sourceLinks).values({ sourceId, nodeId }),
    ).rejects.toThrow(/same user partition/);
    await expect(
      database
        .update(memoryPartitions)
        .set({ status: "quarantined" })
        .where(
          and(
            eq(memoryPartitions.userId, userId),
            eq(memoryPartitions.partitionKey, partitionA),
          ),
        ),
    ).rejects.toThrow(/must remain active/);
  });

  it("reuses one completed split across three sequential sources", async () => {
    const userId = "partition-sequential-reuse";
    const partitionKey = contextPartitionKeySchema.parse(
      "opaque:shared-target",
    );
    const sourceIds = [
      newTypeId("source"),
      newTypeId("source"),
      newTypeId("source"),
    ];
    const sourceNodeId = newTypeId("node");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values(
      sourceIds.map((id, index) => ({
        id,
        userId,
        type: "document" as const,
        externalId: `sequential-${index}`,
      })),
    );
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Person" });
    await database.insert(nodeMetadata).values({
      nodeId: sourceNodeId,
      label: "Shared",
      description: "mixed summary",
    });
    await database
      .insert(sourceLinks)
      .values(
        sourceIds.map((sourceId) => ({ sourceId, nodeId: sourceNodeId })),
      );
    await startMigration(userId);

    const results = [];
    for (const [index, sourceId] of sourceIds.entries()) {
      results.push(
        await reclassifySourcePartition(
          database,
          reclassifySourcePartitionRequestSchema.parse({
            userId,
            sourceId,
            expectedPartitionKey: null,
            targetPartitionKey: partitionKey,
            expectedSourceVersion: 0,
            bindingGeneration: `sequential-${index}`,
          }),
        ),
      );
    }
    const replacementIds = results.map(
      (result) => result.nodeMappings[0]?.replacementNodeId,
    );
    expect(new Set(replacementIds).size).toBe(1);
    expect(
      await database.$count(
        partitionNodeMappings,
        eq(partitionNodeMappings.userId, userId),
      ),
    ).toBe(1);
    const receipts = await database
      .select()
      .from(partitionArtifactReceipts)
      .where(eq(partitionArtifactReceipts.userId, userId));
    expect(receipts).toHaveLength(6);
    expect(receipts.every((receipt) => receipt.disposition !== "pending")).toBe(
      true,
    );
    expect(
      receipts.every(
        (receipt) =>
          receipt.rebuiltCount + receipt.quarantinedCount ===
          receipt.sourceCount,
      ),
    ).toBe(true);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ disposition: "rebuilt" })
        .where(
          and(
            eq(partitionArtifactReceipts.userId, userId),
            eq(partitionArtifactReceipts.artifactKind, "aliases"),
          ),
        ),
    ).rejects.toThrow(/dispositions and counts are immutable/);
    await expect(
      database
        .delete(partitionArtifactReceipts)
        .where(
          and(
            eq(partitionArtifactReceipts.userId, userId),
            eq(partitionArtifactReceipts.artifactKind, "aliases"),
          ),
        ),
    ).rejects.toThrow(/immutable as a complete set/);
  });

  it("rejects identity and payload mutations of completed receipts", async () => {
    const userId = "partition-receipt-field-immutability";
    const otherUserId = `${userId}-other`;
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse(
      "opaque:receipt-fields",
    );
    const otherPartitionKey = contextPartitionKeySchema.parse(
      "opaque:receipt-fields-other",
    );
    await database.insert(users).values([{ id: userId }, { id: otherUserId }]);
    await database.insert(sources).values([
      {
        id: sourceA,
        userId,
        type: "document",
        externalId: "receipt-fields-a",
      },
      {
        id: sourceB,
        userId,
        type: "document",
        externalId: "receipt-fields-b",
      },
    ]);
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Person" });
    await database.insert(sourceLinks).values([
      { sourceId: sourceA, nodeId: sourceNodeId },
      { sourceId: sourceB, nodeId: sourceNodeId },
    ]);
    await database.insert(aliases).values([
      {
        id: newTypeId("alias"),
        userId,
        aliasText: "Receipt Alias",
        normalizedAliasText: "receipt alias",
        canonicalNodeId: sourceNodeId,
      },
      {
        id: newTypeId("alias"),
        userId,
        aliasText: "Receipt Alias Two",
        normalizedAliasText: "receipt alias two",
        canonicalNodeId: sourceNodeId,
      },
    ]);
    await startMigration(userId);
    await database.insert(memoryPartitions).values([
      { userId, partitionKey },
      { userId, partitionKey: otherPartitionKey },
    ]);
    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceA,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "receipt-fields",
      }),
    );

    const receiptWhere = () =>
      and(
        eq(partitionArtifactReceipts.userId, userId),
        eq(partitionArtifactReceipts.sourceNodeId, sourceNodeId),
        eq(partitionArtifactReceipts.partitionKey, partitionKey),
        eq(partitionArtifactReceipts.artifactKind, "aliases"),
      );
    const immutableMutation = /dispositions and counts are immutable/;
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ userId: otherUserId })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ partitionKey: otherPartitionKey })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({
          sourceNodeId: newTypeId("node"),
          artifactKind: "summary",
        })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ disposition: "rebuilt" })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ sourceCount: 3, quarantinedCount: 3 })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ rebuiltCount: 1, quarantinedCount: 1 })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ rebuiltCount: 2, quarantinedCount: 0 })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ details: { tampered: true } })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ createdAt: new Date(0) })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
    await expect(
      database
        .update(partitionArtifactReceipts)
        .set({ updatedAt: new Date(0) })
        .where(receiptWhere()),
    ).rejects.toThrow(immutableMutation);
  });

  it("reopens a completed mapping when its replacement moves partitions", async () => {
    const userId = "partition-reverse-recovery";
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const partitionA = contextPartitionKeySchema.parse("opaque:reverse-a");
    const partitionB = contextPartitionKeySchema.parse("opaque:reverse-b");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      { id: sourceA, userId, type: "document", externalId: "reverse-a" },
      { id: sourceB, userId, type: "document", externalId: "reverse-b" },
    ]);
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Person" });
    await database.insert(sourceLinks).values([
      { sourceId: sourceA, nodeId: sourceNodeId },
      { sourceId: sourceB, nodeId: sourceNodeId },
    ]);
    await startMigration(userId);
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA },
      { userId, partitionKey: partitionB },
    ]);
    const first = await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceA,
        expectedPartitionKey: null,
        targetPartitionKey: partitionA,
        expectedSourceVersion: 0,
        bindingGeneration: "reverse-first",
      }),
    );
    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceB,
        expectedPartitionKey: null,
        targetPartitionKey: partitionA,
        expectedSourceVersion: 0,
        bindingGeneration: "reverse-second",
      }),
    );
    const replacementNodeId = first.nodeMappings[0]!.replacementNodeId;
    await database.transaction(async (tx) => {
      await tx
        .update(sources)
        .set({ partitionKey: partitionB })
        .where(eq(sources.userId, userId));
      await tx
        .update(nodes)
        .set({ partitionKey: partitionB })
        .where(eq(nodes.id, replacementNodeId));
    });
    const [reopened] = await database
      .select({
        state: partitionNodeMappings.state,
        replacementNodeId: partitionNodeMappings.replacementNodeId,
      })
      .from(partitionNodeMappings)
      .where(
        and(
          eq(partitionNodeMappings.userId, userId),
          eq(partitionNodeMappings.sourceNodeId, sourceNodeId),
          eq(partitionNodeMappings.partitionKey, partitionA),
        ),
      );
    expect(reopened).toMatchObject({
      state: "quarantined",
      replacementNodeId: null,
    });
    const receipts = await database
      .select({ disposition: partitionArtifactReceipts.disposition })
      .from(partitionArtifactReceipts)
      .where(eq(partitionArtifactReceipts.userId, userId));
    expect(receipts.every((receipt) => receipt.disposition === "pending")).toBe(
      true,
    );

    const rebuilt = await database.transaction(async (tx) =>
      reusePartitionNodeMapping({
        tx,
        userId,
        sourceId: sourceA,
        sourceNodeId,
        nodeType: "Person",
        partitionKey: partitionA,
        bindingGeneration: "reverse-rebuild",
      }),
    );
    const [rebuiltNode] = await database
      .select({ partitionKey: nodes.partitionKey })
      .from(nodes)
      .where(eq(nodes.id, rebuilt!.replacementNodeId));
    expect(rebuiltNode?.partitionKey).toBe(partitionA);
  });

  it("conservatively quarantines a later source-owned presentation on reuse", async () => {
    const userId = "partition-presentation-reuse";
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse("opaque:presentation");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      { id: sourceA, userId, type: "document", externalId: "presentation-a" },
      { id: sourceB, userId, type: "document", externalId: "presentation-b" },
    ]);
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Task" });
    await database.insert(sourceLinks).values([
      { sourceId: sourceA, nodeId: sourceNodeId },
      { sourceId: sourceB, nodeId: sourceNodeId },
    ]);
    await database.insert(commitmentPresentations).values({
      taskId: sourceNodeId,
      userId,
      sourceId: sourceA,
      excerpt: "source A",
      why: "first provenance",
    });
    await startMigration(userId);
    const first = await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceA,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "presentation-a",
      }),
    );
    const replacementNodeId = first.nodeMappings[0]!.replacementNodeId;
    await database
      .update(commitmentPresentations)
      .set({ sourceId: sourceB, excerpt: "source B" })
      .where(eq(commitmentPresentations.taskId, sourceNodeId));
    await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId: sourceB,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "presentation-b",
      }),
    );
    expect(
      await database.$count(
        commitmentPresentations,
        eq(commitmentPresentations.taskId, replacementNodeId),
      ),
    ).toBe(0);
    const [receipt] = await database
      .select({
        disposition: partitionArtifactReceipts.disposition,
        sourceCount: partitionArtifactReceipts.sourceCount,
      })
      .from(partitionArtifactReceipts)
      .where(
        and(
          eq(partitionArtifactReceipts.userId, userId),
          eq(partitionArtifactReceipts.artifactKind, "commitment_presentation"),
        ),
      );
    expect(receipt).toMatchObject({
      disposition: "quarantined",
      sourceCount: 2,
    });
  });

  it("refreshes changed source-owned presentation values on same-target reuse", async () => {
    const userId = "partition-presentation-refresh";
    const sourceId = newTypeId("source");
    const otherSourceId = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse(
      "opaque:presentation-refresh",
    );
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      {
        id: sourceId,
        userId,
        type: "document",
        externalId: "presentation-refresh",
      },
      {
        id: otherSourceId,
        userId,
        type: "document",
        externalId: "presentation-refresh-other",
      },
    ]);
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Task" });
    await database.insert(sourceLinks).values([
      { sourceId, nodeId: sourceNodeId },
      { sourceId: otherSourceId, nodeId: sourceNodeId },
    ]);
    await database.insert(commitmentPresentations).values({
      taskId: sourceNodeId,
      userId,
      sourceId,
      excerpt: "original excerpt",
      why: "original provenance",
    });
    await startMigration(userId);
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    const first = await reclassifySourcePartition(
      database,
      reclassifySourcePartitionRequestSchema.parse({
        userId,
        sourceId,
        expectedPartitionKey: null,
        targetPartitionKey: partitionKey,
        expectedSourceVersion: 0,
        bindingGeneration: "presentation-refresh-first",
      }),
    );
    const replacementNodeId = first.nodeMappings[0]!.replacementNodeId;
    await database
      .update(commitmentPresentations)
      .set({ excerpt: "revised excerpt", why: "revised provenance" })
      .where(eq(commitmentPresentations.taskId, sourceNodeId));

    await database.transaction(async (tx) =>
      reusePartitionNodeMapping({
        tx,
        userId,
        sourceId,
        sourceNodeId,
        nodeType: "Task",
        partitionKey,
        bindingGeneration: "presentation-refresh-reuse",
      }),
    );

    const [presentation] = await database
      .select({
        excerpt: commitmentPresentations.excerpt,
        why: commitmentPresentations.why,
      })
      .from(commitmentPresentations)
      .where(eq(commitmentPresentations.taskId, replacementNodeId));
    expect(presentation).toEqual({
      excerpt: "revised excerpt",
      why: "revised provenance",
    });
  });

  it("safely creates or reloads one split under concurrent sources", async () => {
    const userId = "partition-concurrent-reuse";
    const partitionKey = contextPartitionKeySchema.parse(
      "opaque:concurrent-target",
    );
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values([
      { id: sourceA, userId, type: "document", externalId: "concurrent-a" },
      { id: sourceB, userId, type: "document", externalId: "concurrent-b" },
    ]);
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Person" });
    await database.insert(sourceLinks).values([
      { sourceId: sourceA, nodeId: sourceNodeId },
      { sourceId: sourceB, nodeId: sourceNodeId },
    ]);
    await startMigration(userId);

    const clientA = new Client({ connectionString: dsnFor(dbName) });
    const clientB = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([clientA.connect(), clientB.connect()]);
    try {
      const [resultA, resultB] = await Promise.all([
        reclassifySourcePartition(
          drizzle(clientA, { schema, casing: "snake_case" }),
          reclassifySourcePartitionRequestSchema.parse({
            userId,
            sourceId: sourceA,
            expectedPartitionKey: null,
            targetPartitionKey: partitionKey,
            expectedSourceVersion: 0,
            bindingGeneration: "concurrent-a",
          }),
        ),
        reclassifySourcePartition(
          drizzle(clientB, { schema, casing: "snake_case" }),
          reclassifySourcePartitionRequestSchema.parse({
            userId,
            sourceId: sourceB,
            expectedPartitionKey: null,
            targetPartitionKey: partitionKey,
            expectedSourceVersion: 0,
            bindingGeneration: "concurrent-b",
          }),
        ),
      ]);
      expect(resultA.nodeMappings[0]?.replacementNodeId).toBe(
        resultB.nodeMappings[0]?.replacementNodeId,
      );
      expect(
        await database.$count(
          partitionNodeMappings,
          eq(partitionNodeMappings.userId, userId),
        ),
      ).toBe(1);
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it("replays the same binding generation when identical commands race", async () => {
    const userId = "partition-concurrent-command";
    const sourceId = newTypeId("source");
    const partitionKey = contextPartitionKeySchema.parse("opaque:command-race");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "command-race",
    });
    await startMigration(userId);
    const request = reclassifySourcePartitionRequestSchema.parse({
      userId,
      sourceId,
      expectedPartitionKey: null,
      targetPartitionKey: partitionKey,
      expectedSourceVersion: 0,
      bindingGeneration: "same-command",
    });
    const clientA = new Client({ connectionString: dsnFor(dbName) });
    const clientB = new Client({ connectionString: dsnFor(dbName) });
    await Promise.all([clientA.connect(), clientB.connect()]);
    try {
      const results = await Promise.all([
        reclassifySourcePartition(
          drizzle(clientA, { schema, casing: "snake_case" }),
          request,
        ),
        reclassifySourcePartition(
          drizzle(clientB, { schema, casing: "snake_case" }),
          request,
        ),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([
        false,
        true,
      ]);
      expect(results.every((result) => result.sourceVersion === 1)).toBe(true);
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  });

  it("fails typed on quarantine and resumes the durable reservation explicitly", async () => {
    const userId = "partition-quarantine-resume";
    const sourceId = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse("opaque:resume");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "resume",
    });
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Person" });
    await database
      .insert(sourceLinks)
      .values({ sourceId, nodeId: sourceNodeId });
    await startMigration(userId);
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await database.insert(partitionNodeMappings).values({
      userId,
      sourceNodeId,
      partitionKey,
      sourceId,
      bindingGeneration: "interrupted",
      state: "quarantined",
    });
    await expect(
      reclassifySourcePartition(
        database,
        reclassifySourcePartitionRequestSchema.parse({
          userId,
          sourceId,
          expectedPartitionKey: null,
          targetPartitionKey: partitionKey,
          expectedSourceVersion: 0,
          bindingGeneration: "new-command",
        }),
      ),
    ).rejects.toMatchObject({ code: "MAPPING_QUARANTINED" });
    const resumed = await resumePartitionNodeRecovery(database, {
      userId,
      sourceNodeId,
      partitionKey,
    });
    expect(resumed.replacementNodeId).not.toBe(sourceNodeId);
    const [mapping] = await database
      .select({ state: partitionNodeMappings.state })
      .from(partitionNodeMappings)
      .where(eq(partitionNodeMappings.userId, userId));
    expect(mapping?.state).toBe("completed");
  });

  it("keeps recovery history after ordinary deletion and cascades it with the user", async () => {
    const userId = "partition-deletion-durability";
    const sourceId = newTypeId("source");
    const sourceNodeId = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse("opaque:durable");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "durable",
    });
    await database
      .insert(nodes)
      .values({ id: sourceNodeId, userId, nodeType: "Person" });
    await startMigration(userId);
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await database.insert(partitionNodeMappings).values({
      userId,
      sourceNodeId,
      partitionKey,
      sourceId,
      bindingGeneration: "durable",
      state: "quarantined",
    });
    await database.insert(sourcePartitionCommands).values({
      userId,
      sourceId,
      bindingGeneration: "durable",
      expectedPartitionKey: null,
      targetPartitionKey: partitionKey,
      expectedSourceVersion: 0,
      sourceVersion: 1,
      movedClaimCount: 0,
      nodeMappings: [],
    });
    await database.delete(sources).where(eq(sources.id, sourceId));
    await database.delete(nodes).where(eq(nodes.id, sourceNodeId));
    expect(
      await database.$count(
        partitionNodeMappings,
        eq(partitionNodeMappings.userId, userId),
      ),
    ).toBe(1);
    expect(
      await database.$count(
        sourcePartitionCommands,
        eq(sourcePartitionCommands.userId, userId),
      ),
    ).toBe(1);
    await database.delete(users).where(eq(users.id, userId));
    expect(
      await database.$count(
        partitionNodeMappings,
        eq(partitionNodeMappings.userId, userId),
      ),
    ).toBe(0);
    expect(
      await database.$count(
        sourcePartitionCommands,
        eq(sourcePartitionCommands.userId, userId),
      ),
    ).toBe(0);
  });

  it("reports authoritative progress and paginates recovery inventory", async () => {
    const userId = "partition-inventory";
    const sourceId = newTypeId("source");
    const sourceNodeA = newTypeId("node");
    const sourceNodeB = newTypeId("node");
    const partitionKey = contextPartitionKeySchema.parse("opaque:inventory");
    await database.insert(users).values({ id: userId });
    await database.insert(sources).values({
      id: sourceId,
      userId,
      type: "document",
      externalId: "inventory",
    });
    await database.insert(nodes).values([
      { id: sourceNodeA, userId, nodeType: "Person" },
      { id: sourceNodeB, userId, nodeType: "Person" },
    ]);
    await startMigration(userId);
    await database.insert(memoryPartitions).values({ userId, partitionKey });
    await database.insert(partitionNodeMappings).values([
      {
        userId,
        sourceNodeId: sourceNodeA,
        partitionKey,
        sourceId,
        bindingGeneration: "inventory-a",
        state: "quarantined",
      },
      {
        userId,
        sourceNodeId: sourceNodeB,
        partitionKey,
        sourceId,
        bindingGeneration: "inventory-b",
        state: "quarantined",
      },
    ]);
    await expect(
      getPartitionProgress(database, { userId, sourceId }),
    ).resolves.toMatchObject({
      migration: { state: "migrating", version: 1 },
      source: { sourceId, partitionKey: null, version: 0 },
    });
    const firstPage = await getPartitionInventory(database, {
      userId,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    if (firstPage.nextCursor === null) throw new Error("Expected another page");
    const secondPage = await getPartitionInventory(database, {
      userId,
      limit: 1,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]?.sourceNodeId).not.toBe(
      firstPage.items[0]?.sourceNodeId,
    );
    expect(secondPage.nextCursor).toBeNull();
  });

  it("quarantines mixed legacy rollups and enforces partition-scoped identity", async () => {
    const userId = "partition-rollup-boundary";
    const partitionKey = contextPartitionKeySchema.parse("opaque:rollup");
    await database.insert(users).values({ id: userId });
    await database.insert(rollupState).values({
      userId,
      pendingPeriods: ["day:legacy"],
    });
    await startMigration(userId);
    await expect(
      database
        .update(rollupState)
        .set({ watermark: new Date() })
        .where(eq(rollupState.userId, userId)),
    ).rejects.toThrow(/requires a partition/);
    await setPartitionMigrationState(
      database,
      setPartitionMigrationStateRequestSchema.parse({
        userId,
        expectedState: "migrating",
        expectedVersion: 1,
        nextState: "migrated",
        unassignedPartitionKey: partitionKey,
      }),
    );
    expect(
      await database.$count(rollupState, eq(rollupState.userId, userId)),
    ).toBe(0);
    await database.insert(rollupState).values({ userId, partitionKey });
    await expect(
      database.insert(rollupState).values({ userId, partitionKey }),
    ).rejects.toThrow(/rollup_state_user_partition_unique/);
  });
});
