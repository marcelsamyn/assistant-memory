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
import { findDayNode } from "~/lib/graph";
import {
  getSourceIngestionOperationById,
  resolveSourceProcessingPartition,
} from "~/lib/ingestion/source-processing";
import { pruneStaleNodesWorkspace } from "~/lib/jobs/prune-stale-nodes";
import {
  ensurePersonalPartition,
  partitionAccessCondition,
} from "~/lib/partition-access";
import { resolveCitations } from "~/lib/resolve-citations";
import {
  contextPartitionKeySchema,
  MEMORY_PERSONAL_PARTITION_KEY,
} from "~/lib/schemas/partition";
import { newTypeId, type TypeId } from "~/types/typeid";

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

  it("classifies explicit self assignments as own work across active partitions without rewriting claims", async () => {
    const selfUserId = "workspace-self-commitments";
    await database.insert(users).values({ id: selfUserId });
    await database.insert(memoryPartitions).values([
      { userId: selfUserId, partitionKey: partitionA, status: "active" },
      { userId: selfUserId, partitionKey: partitionB, status: "active" },
    ]);
    await database.insert(partitionMigrationState).values({
      userId: selfUserId,
      state: "migrated",
    });
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
      "~/utils/test-overrides"
    );
    setSkipEmbeddingPersistence(true);
    try {
      const { createCommitment, setCommitmentOwner } = await import(
        "./commitments"
      );
      const { createCommitmentRequestSchema } = await import(
        "./schemas/create-commitment"
      );
      const { setCommitmentOwnerRequestSchema } = await import(
        "./schemas/set-commitment-owner"
      );
      const { listCommitmentsRequestSchema } = await import(
        "./schemas/list-commitments"
      );
      const { getOpenCommitments, getCandidateCommitments } = await import(
        "./query/open-commitments"
      );
      const { listCommitments } = await import("./query/commitments-list");
      const { getCommitment } = await import("./query/commitment-detail");

      const taskIds: TypeId<"node">[] = [];
      for (const [partitionKey, label] of [
        [partitionA, "Marcel Samyn"],
        [partitionB, "Marcel (User)"],
      ] as const) {
        const selfId = newTypeId("node");
        const contactId = newTypeId("node");
        await database.insert(nodes).values([
          { id: selfId, userId: selfUserId, partitionKey, nodeType: "Person" },
          {
            id: contactId,
            userId: selfUserId,
            partitionKey,
            nodeType: "Person",
          },
        ]);
        await database.insert(nodeMetadata).values([
          { nodeId: selfId, label, additionalData: { isUserSelf: true } },
          { nodeId: contactId, label },
        ]);
        const created = await createCommitment({
          ...createCommitmentRequestSchema.parse({
            userId: selfUserId,
            label: `Own work ${partitionKey}`,
            ownedBy: selfId,
          }),
          accessScope: "workspace",
        });
        taskIds.push(created.taskId);
        expect.soft(created.owner).toBeNull();
        expect(created.ownerClaimId).not.toBeNull();

        const scope = { userId: selfUserId, partitionKey };
        const readList = () =>
          listCommitments(listCommitmentsRequestSchema.parse(scope));
        expect.soft((await getOpenCommitments(scope))[0]?.owner).toBeNull();
        expect.soft((await readList()).commitments[0]?.owner).toBeNull();
        const detail = await getCommitment({
          ...scope,
          taskId: created.taskId,
          includeHistory: true,
          includeSources: true,
        });
        expect.soft(detail.owner).toBeNull();
        expect(detail.history).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              claimId: created.ownerClaimId,
              predicate: "ASSIGNED_TO",
              objectNodeId: selfId,
              status: "active",
            }),
          ]),
        );
        // Filtering still describes stored assignments, independently of display classification.
        expect(
          (await getOpenCommitments({ ...scope, ownedBy: selfId })).map(
            (task) => task.taskId,
          ),
        ).toEqual([created.taskId]);
        expect(
          (
            await listCommitments(
              listCommitmentsRequestSchema.parse({ ...scope, ownedBy: selfId }),
            )
          ).commitments.map((task) => task.taskId),
        ).toEqual([created.taskId]);
        expect(
          (
            await listCommitments(
              listCommitmentsRequestSchema.parse({ ...scope, unowned: true }),
            )
          ).commitments,
        ).toEqual([]);

        const assigned = await setCommitmentOwner({
          ...setCommitmentOwnerRequestSchema.parse({
            userId: selfUserId,
            taskId: created.taskId,
            ownedBy: contactId,
          }),
          accessScope: "workspace",
        });
        const externalOwner = { nodeId: contactId, label };
        expect(assigned.owner).toEqual(externalOwner);
        expect((await getOpenCommitments(scope))[0]?.owner).toEqual(
          externalOwner,
        );
        expect((await readList()).commitments[0]?.owner).toEqual(externalOwner);

        await database
          .update(nodeMetadata)
          .set({ additionalData: { isUserSelf: "true" } })
          .where(eq(nodeMetadata.nodeId, contactId));
        expect((await getOpenCommitments(scope))[0]?.owner).toEqual(
          externalOwner,
        );
        expect((await readList()).commitments[0]?.owner).toEqual(externalOwner);

        const reassigned = await setCommitmentOwner({
          ...setCommitmentOwnerRequestSchema.parse({
            userId: selfUserId,
            taskId: created.taskId,
            ownedBy: selfId,
          }),
          accessScope: "workspace",
        });
        expect.soft(reassigned.owner).toBeNull();
        expect(reassigned.claimId).not.toBeNull();
        expect.soft((await getOpenCommitments(scope))[0]?.owner).toBeNull();
        expect.soft((await readList()).commitments[0]?.owner).toBeNull();
        expect
          .soft(
            (
              await getCommitment({
                ...scope,
                taskId: created.taskId,
                includeHistory: false,
                includeSources: false,
              })
            ).owner,
          )
          .toBeNull();
        if (reassigned.claimId === null)
          throw new Error("Self assignment must retain its claim");
        const [stored] = await database
          .select()
          .from(claims)
          .where(eq(claims.id, reassigned.claimId));
        expect(stored).toMatchObject({
          objectNodeId: selfId,
          status: "active",
          partitionKey,
        });

        // Existing inferred assignments use the same projection as trusted work.
        await database
          .update(claims)
          .set({ assertedByKind: "assistant_inferred" })
          .where(eq(claims.id, created.statusClaimId));
        expect
          .soft((await getCandidateCommitments(scope))[0]?.owner)
          .toBeNull();
        expect
          .soft(
            (
              await listCommitments(
                listCommitmentsRequestSchema.parse({
                  ...scope,
                  provenance: "candidate",
                }),
              )
            ).commitments[0]?.owner,
          )
          .toBeNull();
        await database
          .update(claims)
          .set({ assertedByKind: "user" })
          .where(eq(claims.id, created.statusClaimId));
      }
      const workspace = await getOpenCommitments({
        userId: selfUserId,
        accessScope: "workspace",
      });
      expect(workspace.map((task) => task.taskId).sort()).toEqual(
        [...taskIds].sort(),
      );
      expect.soft(workspace.every((task) => task.owner === null)).toBe(true);
      await expect(
        getOpenCommitments({ userId: selfUserId }),
      ).rejects.toMatchObject({ code: "PARTITION_REQUIRED" });
      expect(
        await getOpenCommitments({
          userId: otherUserId,
          accessScope: "workspace",
        }),
      ).toEqual([]);
      // Model historical inactive rows; current writes prohibit quarantining in-use partitions.
      await client.query(
        'ALTER TABLE "memory_partitions" DISABLE TRIGGER USER',
      );
      try {
        await database
          .update(memoryPartitions)
          .set({ status: "quarantined" })
          .where(
            and(
              eq(memoryPartitions.userId, selfUserId),
              eq(memoryPartitions.partitionKey, partitionB),
            ),
          );
      } finally {
        await client.query(
          'ALTER TABLE "memory_partitions" ENABLE TRIGGER USER',
        );
      }
      expect(
        (
          await getOpenCommitments({
            userId: selfUserId,
            accessScope: "workspace",
          })
        ).map((task) => task.taskId),
      ).toEqual([taskIds[0]]);

      const firstTaskId = taskIds[0];
      if (firstTaskId === undefined) throw new Error("Expected an active task");
      const [taskSource] = await database
        .select({ id: sources.id, version: sources.version })
        .from(claims)
        .innerJoin(sources, eq(sources.id, claims.sourceId))
        .where(
          and(
            eq(claims.subjectNodeId, firstTaskId),
            eq(claims.predicate, "HAS_TASK_STATUS"),
          ),
        );
      if (!taskSource) throw new Error("Expected the task's source");
      const { applySourceLifecycleCommand } = await import(
        "./source-lifecycle"
      );
      await applySourceLifecycleCommand(database, {
        userId: selfUserId,
        sourceId: taskSource.id,
        expectedPartitionKey: partitionA,
        expectedSourceVersion: taskSource.version,
        commandId: "68c4e9db-cd50-4911-8e9a-e2abbd00a491",
        action: "tombstone",
      });
      expect(
        await getOpenCommitments({
          userId: selfUserId,
          accessScope: "workspace",
        }),
      ).toEqual([]);
      expect(
        (
          await listCommitments({
            ...listCommitmentsRequestSchema.parse({ userId: selfUserId }),
            accessScope: "workspace",
          })
        ).commitments,
      ).toEqual([]);
    } finally {
      resetTestOverrides();
      vi.doUnmock("~/utils/db");
      vi.resetModules();
    }
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

  it("returns every active workspace day memory after deduplication", async () => {
    const date = "2026-05-01";
    const dayA = newTypeId("node");
    const dayB = newTypeId("node");
    const activeNodeIds = Array.from({ length: 204 }, () => newTypeId("node"));
    const inactiveNodeId = newTypeId("node");
    const foreignNodeId = newTypeId("node");
    const crossPartitionNodeId = newTypeId("node");
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");

    await database.insert(nodes).values([
      {
        id: dayA,
        userId,
        partitionKey: partitionA,
        nodeType: "Temporal",
      },
      {
        id: dayB,
        userId,
        partitionKey: partitionB,
        nodeType: "Temporal",
      },
      ...activeNodeIds.map((id, index) => ({
        id,
        userId,
        partitionKey: index < 102 ? partitionA : partitionB,
        nodeType: "Object" as const,
      })),
      {
        id: foreignNodeId,
        userId: otherUserId,
        partitionKey: partitionA,
        nodeType: "Object",
      },
      {
        id: crossPartitionNodeId,
        userId,
        partitionKey: partitionB,
        nodeType: "Object",
      },
    ]);
    await client.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await database.insert(nodes).values({
        id: inactiveNodeId,
        userId,
        partitionKey: quarantined,
        nodeType: "Object",
      });
    } finally {
      await client.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }
    await database.insert(nodeMetadata).values([
      { id: newTypeId("node_metadata"), nodeId: dayA, label: date },
      { id: newTypeId("node_metadata"), nodeId: dayB, label: date },
      ...activeNodeIds.map((nodeId, index) => ({
        id: newTypeId("node_metadata"),
        nodeId,
        label: `Day memory ${index}`,
        description: `Complete day memory ${index}`,
      })),
      {
        id: newTypeId("node_metadata"),
        nodeId: inactiveNodeId,
        label: "Inactive day memory",
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: foreignNodeId,
        label: "Foreign day memory",
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: crossPartitionNodeId,
        label: "Cross-partition day memory",
      },
    ]);
    await database.insert(sources).values([
      {
        id: sourceA,
        userId,
        type: "manual",
        externalId: "workspace-day-large-source-a",
        partitionKey: partitionA,
      },
      {
        id: sourceB,
        userId,
        type: "manual",
        externalId: "workspace-day-large-source-b",
        partitionKey: partitionB,
      },
    ]);
    const activeClaims = activeNodeIds.map((nodeId, index) => ({
      id: newTypeId("claim"),
      userId,
      partitionKey: index < 102 ? partitionA : partitionB,
      subjectNodeId: nodeId,
      objectNodeId: index < 102 ? dayA : dayB,
      predicate: "OCCURRED_ON" as const,
      statement: `Day memory ${index} occurred on ${date}.`,
      sourceId: index < 102 ? sourceA : sourceB,
      assertedByKind: "user" as const,
      statedAt: new Date("2026-05-01T12:00:00Z"),
    }));
    await database.insert(claims).values([
      ...activeClaims,
      {
        ...activeClaims[0]!,
        id: newTypeId("claim"),
        statement: `Day memory 0 was also recorded on ${date}.`,
      },
    ]);
    await client.query(`ALTER TABLE "claims" DISABLE TRIGGER USER`);
    try {
      await database.insert(claims).values([
        {
          id: newTypeId("claim"),
          userId,
          partitionKey: partitionA,
          subjectNodeId: foreignNodeId,
          objectNodeId: dayA,
          predicate: "OCCURRED_ON",
          statement: "Foreign day memory must stay hidden.",
          sourceId: sourceA,
          assertedByKind: "user",
          statedAt: new Date("2026-05-01T13:00:00Z"),
        },
        {
          id: newTypeId("claim"),
          userId,
          partitionKey: partitionA,
          subjectNodeId: inactiveNodeId,
          objectNodeId: dayA,
          predicate: "OCCURRED_ON",
          statement: "Inactive day memory must stay hidden.",
          sourceId: sourceA,
          assertedByKind: "user",
          statedAt: new Date("2026-05-01T14:00:00Z"),
        },
        {
          id: newTypeId("claim"),
          userId,
          partitionKey: partitionA,
          subjectNodeId: crossPartitionNodeId,
          objectNodeId: dayA,
          predicate: "OCCURRED_ON",
          statement: "Cross-partition day memory must stay hidden.",
          sourceId: sourceA,
          assertedByKind: "user",
          statedAt: new Date("2026-05-01T15:00:00Z"),
        },
      ]);
    } finally {
      await client.query(`ALTER TABLE "claims" ENABLE TRIGGER USER`);
    }

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    try {
      const { queryDayMemories } = await import("./query/day");
      const result = await queryDayMemories({
        userId,
        date,
        includeFormattedResult: true,
        accessScope: "workspace",
      });
      const formattedResult = result.formattedResult ?? "";

      expect(result.nodeCount).toBe(activeNodeIds.length);
      expect(new Set(result.nodes.map((node) => node.id)).size).toBe(
        activeNodeIds.length,
      );
      expect(result.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining(activeNodeIds),
      );
      for (const index of activeNodeIds.keys()) {
        expect(formattedResult).toContain(`**Day memory ${index}**`);
      }
      expect(formattedResult).not.toContain("Foreign day memory");
      expect(formattedResult).not.toContain("Inactive day memory");
      expect(formattedResult).not.toContain("Cross-partition day memory");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
    }
  });

  it("reads day memories from every active workspace partition", async () => {
    const manyUserId = "workspace-access-many-days";
    const manyForeignUserId = "workspace-access-many-days-foreign";
    const date = "2026-05-02";
    const activePartitions = Array.from({ length: 65 }, (_, index) =>
      contextPartitionKeySchema.parse(
        `room:day-${String(index).padStart(2, "0")}`,
      ),
    );
    const inactivePartition = contextPartitionKeySchema.parse(
      "room:day-quarantined",
    );
    const dayIds = Array.from({ length: 65 }, () => newTypeId("node"));
    const lastDayId = [...dayIds].sort().at(-1)!;
    const lastPartition = activePartitions[dayIds.indexOf(lastDayId)]!;
    const activeMemoryId = newTypeId("node");
    const inactiveDayId = newTypeId("node");
    const inactiveMemoryId = newTypeId("node");
    const foreignDayId = newTypeId("node");
    const foreignMemoryId = newTypeId("node");
    const sourceId = newTypeId("source");
    const foreignSourceId = newTypeId("source");

    await database
      .insert(users)
      .values([{ id: manyUserId }, { id: manyForeignUserId }]);
    await database.insert(memoryPartitions).values([
      ...activePartitions.map((partitionKey) => ({
        userId: manyUserId,
        partitionKey,
        status: "active" as const,
      })),
      {
        userId: manyUserId,
        partitionKey: inactivePartition,
        status: "quarantined",
      },
      {
        userId: manyForeignUserId,
        partitionKey: activePartitions[0]!,
        status: "active",
      },
    ]);
    await database.insert(partitionMigrationState).values([
      { userId: manyUserId, state: "migrated", version: 1 },
      { userId: manyForeignUserId, state: "migrated", version: 1 },
    ]);
    await database.insert(nodes).values([
      ...dayIds.map((id, index) => ({
        id,
        userId: manyUserId,
        partitionKey: activePartitions[index]!,
        nodeType: "Temporal" as const,
      })),
      {
        id: activeMemoryId,
        userId: manyUserId,
        partitionKey: lastPartition,
        nodeType: "Person" as const,
      },
      {
        id: foreignDayId,
        userId: manyForeignUserId,
        partitionKey: activePartitions[0]!,
        nodeType: "Temporal" as const,
      },
      {
        id: foreignMemoryId,
        userId: manyForeignUserId,
        partitionKey: activePartitions[0]!,
        nodeType: "Person" as const,
      },
    ]);
    await client.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await database.insert(nodes).values([
        {
          id: inactiveDayId,
          userId: manyUserId,
          partitionKey: inactivePartition,
          nodeType: "Temporal",
        },
        {
          id: inactiveMemoryId,
          userId: manyUserId,
          partitionKey: inactivePartition,
          nodeType: "Person",
        },
      ]);
    } finally {
      await client.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }
    await database.insert(nodeMetadata).values([
      ...dayIds.map((nodeId) => ({
        id: newTypeId("node_metadata"),
        nodeId,
        label: date,
      })),
      {
        id: newTypeId("node_metadata"),
        nodeId: activeMemoryId,
        label: "Active many-partition memory",
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: inactiveDayId,
        label: date,
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: inactiveMemoryId,
        label: "Inactive many-partition memory",
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: foreignDayId,
        label: date,
      },
      {
        id: newTypeId("node_metadata"),
        nodeId: foreignMemoryId,
        label: "Foreign many-partition memory",
      },
    ]);
    await database.insert(sources).values([
      {
        id: sourceId,
        userId: manyUserId,
        type: "manual",
        externalId: "workspace-many-days-source",
        partitionKey: lastPartition,
      },
      {
        id: foreignSourceId,
        userId: manyForeignUserId,
        type: "manual",
        externalId: "workspace-many-days-foreign-source",
        partitionKey: activePartitions[0]!,
      },
    ]);
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId: manyUserId,
      partitionKey: lastPartition,
      subjectNodeId: activeMemoryId,
      objectNodeId: lastDayId,
      predicate: "OCCURRED_ON",
      statement: `Active memory occurred on ${date}.`,
      sourceId,
      assertedByKind: "user",
      statedAt: new Date("2026-05-02T12:00:00Z"),
    });
    await client.query(`ALTER TABLE "claims" DISABLE TRIGGER USER`);
    try {
      await database.insert(claims).values([
        {
          id: newTypeId("claim"),
          userId: manyUserId,
          partitionKey: inactivePartition,
          subjectNodeId: inactiveMemoryId,
          objectNodeId: inactiveDayId,
          predicate: "OCCURRED_ON",
          statement: `Inactive memory occurred on ${date}.`,
          sourceId,
          assertedByKind: "user",
          statedAt: new Date("2026-05-02T13:00:00Z"),
        },
        {
          id: newTypeId("claim"),
          userId: manyUserId,
          partitionKey: activePartitions[0]!,
          subjectNodeId: foreignMemoryId,
          objectNodeId: foreignDayId,
          predicate: "OCCURRED_ON",
          statement: `Foreign memory occurred on ${date}.`,
          sourceId,
          assertedByKind: "user",
          statedAt: new Date("2026-05-02T14:00:00Z"),
        },
      ]);
    } finally {
      await client.query(`ALTER TABLE "claims" ENABLE TRIGGER USER`);
    }

    expect(await findDayNode(database, manyUserId, date, lastPartition)).toBe(
      lastDayId,
    );
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    try {
      const { queryDayMemories } = await import("./query/day");
      await expect(
        queryDayMemories({
          userId: manyUserId,
          date,
          includeFormattedResult: true,
          accessScope: "workspace",
        }),
      ).resolves.toMatchObject({
        nodeCount: 1,
        nodes: [
          expect.objectContaining({
            id: activeMemoryId,
            nodeType: "Person",
          }),
        ],
        formattedResult: expect.stringContaining(
          "Active many-partition memory",
        ),
      });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
    }
  });

  it("does not cap complete workspace atlas reads before ownership checks", async () => {
    const largeUserId = "workspace-access-large-atlas";
    const foreignUserId = "workspace-access-large-atlas-foreign";
    const assistantId = "assistant-workspace-large";
    const activePartition =
      contextPartitionKeySchema.parse("room:large-active");
    const secondPartition =
      contextPartitionKeySchema.parse("room:large-second");
    const inactivePartition = contextPartitionKeySchema.parse(
      "room:large-quarantined",
    );
    const sourceId = newTypeId("source");
    const userAtlasIds = Array.from({ length: 33 }, () => newTypeId("node"));
    const assistantAtlasIds = Array.from({ length: 33 }, () =>
      newTypeId("node"),
    );
    const assistantAtlasId = assistantAtlasIds[0]!;
    const endpointIds = Array.from({ length: 501 }, () => newTypeId("node"));
    const inactiveEndpointId = newTypeId("node");
    const foreignEndpointId = newTypeId("node");
    const crossPartitionEndpointId = newTypeId("node");

    await database
      .insert(users)
      .values([{ id: largeUserId }, { id: foreignUserId }]);
    await database.insert(memoryPartitions).values([
      { userId: largeUserId, partitionKey: activePartition, status: "active" },
      { userId: largeUserId, partitionKey: secondPartition, status: "active" },
      {
        userId: largeUserId,
        partitionKey: inactivePartition,
        status: "quarantined",
      },
      {
        userId: foreignUserId,
        partitionKey: activePartition,
        status: "active",
      },
    ]);
    await database.insert(nodes).values([
      ...userAtlasIds.map((id) => ({
        id,
        userId: largeUserId,
        partitionKey: activePartition,
        nodeType: "Atlas" as const,
      })),
      ...assistantAtlasIds.map((id) => ({
        id,
        userId: largeUserId,
        partitionKey: activePartition,
        nodeType: "Atlas" as const,
      })),
      ...endpointIds.map((id) => ({
        id,
        userId: largeUserId,
        partitionKey: activePartition,
        nodeType: "Object" as const,
      })),
      {
        id: inactiveEndpointId,
        userId: largeUserId,
        partitionKey: inactivePartition,
        nodeType: "Object" as const,
      },
      {
        id: foreignEndpointId,
        userId: foreignUserId,
        partitionKey: activePartition,
        nodeType: "Object" as const,
      },
      {
        id: crossPartitionEndpointId,
        userId: largeUserId,
        partitionKey: secondPartition,
        nodeType: "Object" as const,
      },
    ]);
    await database.insert(nodeMetadata).values([
      ...userAtlasIds.map((nodeId, index) => ({
        id: newTypeId("node_metadata"),
        nodeId,
        label: "Atlas",
        description: `Atlas entry ${index}`,
      })),
      ...assistantAtlasIds.map((nodeId, index) => ({
        id: newTypeId("node_metadata"),
        nodeId,
        label: assistantId,
        description: `Assistant atlas entry ${index}`,
      })),
    ]);
    await database.insert(sources).values({
      id: sourceId,
      userId: largeUserId,
      type: "manual",
      externalId: "workspace-large-atlas-source",
      partitionKey: activePartition,
    });
    await database.insert(claims).values(
      endpointIds.map((objectNodeId) => ({
        id: newTypeId("claim"),
        userId: largeUserId,
        partitionKey: activePartition,
        subjectNodeId: assistantAtlasId,
        objectNodeId,
        predicate: "OWNS" as const,
        statement: "Assistant atlas owns an endpoint.",
        sourceId,
        assertedByKind: "system" as const,
        statedAt: new Date("2026-02-01T00:00:00Z"),
      })),
    );
    // These malformed edges model historical rows that were written before
    // partition integrity was enforced. They must never enter a workspace
    // result after migration.
    await client.query(`ALTER TABLE "claims" DISABLE TRIGGER USER`);
    try {
      await database.insert(claims).values([
        {
          id: newTypeId("claim"),
          userId: largeUserId,
          partitionKey: activePartition,
          subjectNodeId: assistantAtlasId,
          objectNodeId: inactiveEndpointId,
          predicate: "OWNS",
          statement: "Quarantined endpoint must stay hidden.",
          sourceId,
          assertedByKind: "system",
          statedAt: new Date("2026-02-02T00:00:00Z"),
        },
        {
          id: newTypeId("claim"),
          userId: largeUserId,
          partitionKey: activePartition,
          subjectNodeId: assistantAtlasId,
          objectNodeId: foreignEndpointId,
          predicate: "OWNS",
          statement: "Foreign endpoint must stay hidden.",
          sourceId,
          assertedByKind: "system",
          statedAt: new Date("2026-02-03T00:00:00Z"),
        },
        {
          id: newTypeId("claim"),
          userId: largeUserId,
          partitionKey: activePartition,
          subjectNodeId: assistantAtlasId,
          objectNodeId: crossPartitionEndpointId,
          predicate: "OWNS",
          statement: "Cross-partition endpoint must stay hidden.",
          sourceId,
          assertedByKind: "system",
          statedAt: new Date("2026-02-04T00:00:00Z"),
        },
      ]);
    } finally {
      await client.query(`ALTER TABLE "claims" ENABLE TRIGGER USER`);
    }
    await database.insert(partitionMigrationState).values({
      userId: largeUserId,
      state: "migrated",
    });

    const atlasEntries = await getWorkspaceAtlasEntries(
      database,
      largeUserId,
      assistantId,
    );
    expect(atlasEntries.user).toHaveLength(33);
    expect(atlasEntries.assistant).toHaveLength(33);

    const relatedIds = await getWorkspaceAssistantAtlasNodeIds(
      database,
      largeUserId,
      assistantId,
    );
    expect(relatedIds).toHaveLength(501);
    expect(relatedIds).toEqual(expect.arrayContaining(endpointIds));
    expect(relatedIds).not.toContain(inactiveEndpointId);
    expect(relatedIds).not.toContain(foreignEndpointId);
    expect(relatedIds).not.toContain(crossPartitionEndpointId);
  });

  it("ranks stale candidates across active partitions under one total limit", async () => {
    const pruneUserId = "workspace-stale-global";
    const pruneOtherUserId = "workspace-stale-foreign";
    const prunePartitionA = contextPartitionKeySchema.parse("workspace:a");
    const prunePartitionB = contextPartitionKeySchema.parse("workspace:b");
    const pruneInactive = contextPartitionKeySchema.parse("workspace:inactive");
    await database
      .insert(users)
      .values([{ id: pruneUserId }, { id: pruneOtherUserId }]);
    await database.insert(memoryPartitions).values([
      { userId: pruneUserId, partitionKey: prunePartitionA, status: "active" },
      { userId: pruneUserId, partitionKey: prunePartitionB, status: "active" },
      {
        userId: pruneUserId,
        partitionKey: pruneInactive,
        status: "quarantined",
      },
    ]);
    await database.insert(partitionMigrationState).values({
      userId: pruneUserId,
      state: "migrated",
    });

    const highId = newTypeId("node");
    const lowId = newTypeId("node");
    const selfId = newTypeId("node");
    const inactiveId = newTypeId("node");
    const foreignId = newTypeId("node");
    await client.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await database.insert(nodes).values([
        {
          id: highId,
          userId: pruneUserId,
          partitionKey: prunePartitionB,
          nodeType: "Concept",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: lowId,
          userId: pruneUserId,
          partitionKey: prunePartitionA,
          nodeType: "Concept",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: selfId,
          userId: pruneUserId,
          partitionKey: prunePartitionA,
          nodeType: "Person",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: inactiveId,
          userId: pruneUserId,
          partitionKey: pruneInactive,
          nodeType: "Concept",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: foreignId,
          userId: pruneOtherUserId,
          partitionKey: prunePartitionB,
          nodeType: "Concept",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
      ]);
    } finally {
      await client.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }
    await database.insert(nodeMetadata).values([
      {
        nodeId: highId,
        label: "High score",
      },
      {
        nodeId: lowId,
        label: "Low score",
      },
      {
        nodeId: selfId,
        label: "Owner",
        additionalData: { isUserSelf: true },
      },
      {
        nodeId: inactiveId,
        label: "Inactive",
      },
      {
        nodeId: foreignId,
        label: "Foreign",
      },
    ]);

    const sourceId = newTypeId("source");
    await database.insert(sources).values({
      id: sourceId,
      userId: pruneUserId,
      partitionKey: prunePartitionA,
      type: "manual",
      externalId: "workspace-stale-global-source",
    });
    await database.insert(claims).values({
      id: newTypeId("claim"),
      userId: pruneUserId,
      partitionKey: prunePartitionA,
      subjectNodeId: lowId,
      objectValue: "grounded",
      predicate: "HAS_ATTRIBUTE",
      statement: "The low score node has grounded evidence.",
      sourceId,
      assertedByKind: "user",
      statedAt: new Date("2025-01-01T00:00:00Z"),
    });

    const dryRun = await pruneStaleNodesWorkspace(
      {
        userId: pruneUserId,
        limit: 1,
        sampleLimit: 10,
        minIdleDays: 30,
        minScore: 0.5,
      },
      database,
    );
    expect(dryRun.scannedCount).toBe(3);
    expect(dryRun.candidateCount).toBe(2);
    expect(dryRun.deletedCount).toBe(0);
    expect(dryRun.hasMore).toBe(true);
    expect(dryRun.candidates.map((node) => node.id)).toEqual([highId]);

    const applied = await pruneStaleNodesWorkspace(
      {
        userId: pruneUserId,
        dryRun: false,
        limit: 1,
        sampleLimit: 10,
        minIdleDays: 30,
        minScore: 0.5,
      },
      database,
    );
    expect(applied.deletedCount).toBe(1);
    expect(applied.candidates.map((node) => node.id)).toEqual([highId]);
    const remaining = await database
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.userId, pruneUserId));
    expect(remaining.map((node) => node.id)).toEqual(
      expect.arrayContaining([lowId, selfId, inactiveId]),
    );
    expect(remaining.map((node) => node.id)).not.toContain(highId);
    expect(remaining.map((node) => node.id)).not.toContain(foreignId);
  });

  it("reads mixed legacy and active stale rows but rejects a legacy mutation", async () => {
    const mixedUserId = "workspace-stale-mixed";
    const mixedPartition = contextPartitionKeySchema.parse("workspace:mixed");
    const activeId = newTypeId("node");
    const legacyId = newTypeId("node");
    await database.insert(users).values({ id: mixedUserId });
    await database.insert(memoryPartitions).values({
      userId: mixedUserId,
      partitionKey: mixedPartition,
      status: "active",
    });
    await database.insert(partitionMigrationState).values({
      userId: mixedUserId,
      state: "migrating",
    });
    await client.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await database.insert(nodes).values([
        {
          id: activeId,
          userId: mixedUserId,
          partitionKey: mixedPartition,
          nodeType: "Concept",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
        {
          id: legacyId,
          userId: mixedUserId,
          nodeType: "Concept",
          createdAt: new Date("2025-01-01T00:00:00Z"),
        },
      ]);
    } finally {
      await client.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }
    await database.insert(nodeMetadata).values([
      { nodeId: activeId, label: "Active" },
      { nodeId: legacyId, label: "Legacy" },
    ]);

    const dryRun = await pruneStaleNodesWorkspace(
      {
        userId: mixedUserId,
        minIdleDays: 30,
        minScore: 0.5,
        sampleLimit: 10,
      },
      database,
    );
    expect(dryRun.scannedCount).toBe(2);
    expect(dryRun.candidateCount).toBe(2);
    expect(dryRun.deletedCount).toBe(0);

    await expect(
      pruneStaleNodesWorkspace(
        {
          userId: mixedUserId,
          dryRun: false,
          minIdleDays: 30,
          minScore: 0.5,
        },
        database,
      ),
    ).rejects.toMatchObject({ code: "PARTITION_REQUIRED" });
    const remaining = await database
      .select({ id: nodes.id })
      .from(nodes)
      .where(eq(nodes.userId, mixedUserId));
    expect(remaining.map((node) => node.id).sort()).toEqual(
      [activeId, legacyId].sort(),
    );
  });
});
