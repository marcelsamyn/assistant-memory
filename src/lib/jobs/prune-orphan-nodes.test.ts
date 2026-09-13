/**
 * DB-integration tests for deterministic orphan node pruning.
 *
 * The job is intentionally not LLM-driven: evidence-free legacy nodes can be
 * deleted mechanically, while anything with claims or aliases must survive.
 */
import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import type { SourceBlobStore } from "~/lib/sources";
import { newTypeId, type TypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string): string =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

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

const SERVER_AVAILABLE = await isServerReachable();
const describeIfServer = SERVER_AVAILABLE ? describe : describe.skip;

type TestDb = NodePgDatabase<typeof schema>;

async function seedNode(
  client: Client,
  args: {
    id: TypeId<"node">;
    userId: string;
    nodeType: string;
    label: string;
    createdAt?: Date;
    partitionKey?: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
    [args.userId],
  );
  await client.query(
    `INSERT INTO "nodes" ("id", "user_id", "partition_key", "node_type", "created_at")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      args.id,
      args.userId,
      args.partitionKey ?? null,
      args.nodeType,
      args.createdAt ?? new Date("2026-04-01T00:00:00.000Z"),
    ],
  );
  await client.query(
    `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
     VALUES ($1, $2, $3, lower($3))`,
    [newTypeId("node_metadata"), args.id, args.label],
  );
}

async function seedSource(
  client: Client,
  args: {
    sourceId: TypeId<"source">;
    userId: string;
    blobBacked?: boolean;
    partitionKey?: string;
    createdAt?: Date;
    parentSourceId?: TypeId<"source">;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "sources" (
       "id", "user_id", "type", "external_id", "scope", "metadata",
       "content_type", "content_length", "partition_key", "parent_source", "created_at"
     )
     VALUES ($1, $2, 'legacy_migration', $3, 'personal', '{}'::jsonb, $4, $5, $6, $7, $8)`,
    [
      args.sourceId,
      args.userId,
      `legacy_migration:${args.sourceId}`,
      args.blobBacked ? "text/plain" : null,
      args.blobBacked ? 42 : null,
      args.partitionKey ?? null,
      args.parentSourceId ?? null,
      args.createdAt ?? new Date("2026-04-01T00:00:00.000Z"),
    ],
  );
}

function blobStoreWithExistingSources(
  sourceIds: TypeId<"source">[],
): SourceBlobStore {
  return {
    async listBlobSourceIds() {
      return new Set(sourceIds);
    },
  };
}

describeIfServer("pruneOrphanNodes", () => {
  const dbName = `memory_prune_orphans_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  let database: TestDb;
  let rootClient: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    rootClient = new Client({ connectionString: dsnFor(dbName) });
    await rootClient.connect();
    database = drizzle(rootClient, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    await rootClient.end();

    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  afterEach(async () => {
    await rootClient.query(
      `TRUNCATE "aliases", "claims", "source_links",
              "node_metadata", "nodes", "sources", "users" CASCADE`,
    );
  });

  it("dry run finds entity orphans but excludes generated node types by default", async () => {
    const userId = "user_prune_dryrun";
    const orphanId = newTypeId("node");
    const dreamId = newTypeId("node");
    await seedNode(rootClient, {
      id: orphanId,
      userId,
      nodeType: "Concept",
      label: "orphan concept",
    });
    await seedNode(rootClient, {
      id: dreamId,
      userId,
      nodeType: "AssistantDream",
      label: "dream",
    });

    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes({ userId }, database);

    expect(result.dryRun).toBe(true);
    expect(result.candidateCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(result.hasMore).toBe(false);
    expect(result.candidates.map((node) => node.id)).toEqual([orphanId]);

    const remaining = await rootClient.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "nodes" WHERE "user_id" = $1`,
      [userId],
    );
    expect(remaining.rows[0]?.count).toBe("2");
  });

  it("deletes source-only nodes and preserves nodes with graph evidence", async () => {
    const userId = "user_prune_delete";
    const orphanId = newTypeId("node");
    const claimNodeId = newTypeId("node");
    const sourceLinkedId = newTypeId("node");
    const aliasNodeId = newTypeId("node");
    const speakerNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    for (const [id, label] of [
      [orphanId, "orphan"],
      [claimNodeId, "claimed"],
      [sourceLinkedId, "source linked"],
      [aliasNodeId, "aliased"],
      [speakerNodeId, "speaker"],
    ] as const) {
      await seedNode(rootClient, {
        id,
        userId,
        nodeType: "Concept",
        label,
      });
    }
    await seedSource(rootClient, { sourceId, userId });

    await rootClient.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_value", "predicate",
        "statement", "source_id", "scope", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, 'value', 'RELATED_TO', 'Claimed node has evidence.', $4, 'personal', 'user', now())`,
      [newTypeId("claim"), userId, claimNodeId, sourceId],
    );
    await rootClient.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_value", "predicate",
        "statement", "source_id", "scope", "asserted_by_kind", "asserted_by_node_id", "stated_at"
      ) VALUES ($1, $2, $3, 'value', 'RELATED_TO', 'Speaker node is provenance.', $4, 'personal', 'participant', $5, now())`,
      [newTypeId("claim"), userId, claimNodeId, sourceId, speakerNodeId],
    );
    await rootClient.query(
      `INSERT INTO "source_links" ("id", "source_id", "node_id")
       VALUES ($1, $2, $3)`,
      [newTypeId("source_link"), sourceId, sourceLinkedId],
    );
    await rootClient.query(
      `INSERT INTO "aliases" ("id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id")
       VALUES ($1, $2, 'Alias', 'alias', $3)`,
      [newTypeId("alias"), userId, aliasNodeId],
    );

    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes(
      { userId, dryRun: false, limit: 10 },
      database,
    );

    expect(result.candidateCount).toBe(2);
    expect(result.deletedCount).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.candidates.map((node) => node.id).sort()).toEqual(
      [orphanId, sourceLinkedId].sort(),
    );

    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
      [userId],
    );
    expect(remaining.rows.map((row) => row.id).sort()).toEqual(
      [claimNodeId, aliasNodeId, speakerNodeId].sort(),
    );
  });

  it("deletes missing blob-backed sources before pruning newly orphaned nodes", async () => {
    const userId = "user_prune_missing_blob";
    const nodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    await seedNode(rootClient, {
      id: nodeId,
      userId,
      nodeType: "Concept",
      label: "source-only concept",
    });
    await seedSource(rootClient, { sourceId, userId, blobBacked: true });
    await rootClient.query(
      `INSERT INTO "source_links" ("id", "source_id", "node_id")
       VALUES ($1, $2, $3)`,
      [newTypeId("source_link"), sourceId, nodeId],
    );
    await rootClient.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_value", "predicate",
        "statement", "source_id", "scope", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, 'value', 'RELATED_TO', 'Claim backed by missing blob.', $4, 'personal', 'user', now())`,
      [newTypeId("claim"), userId, nodeId, sourceId],
    );

    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes(
      { userId, dryRun: false, limit: 10 },
      database,
      blobStoreWithExistingSources([]),
    );

    expect(result.sourceScanCount).toBe(1);
    expect(result.missingBlobSourceCandidateCount).toBe(1);
    expect(result.deletedMissingBlobSourceCount).toBe(1);
    // Lifecycle tombstone retracts the linked node and claim itself; the
    // ordinary orphan pass has nothing unsafe left to delete afterward.
    expect(result.candidateCount).toBe(0);
    expect(result.deletedCount).toBe(0);
    expect(result.missingBlobSources.map((source) => source.id)).toEqual([
      sourceId,
    ]);
    expect(result.candidates).toEqual([]);

    const counts = await rootClient.query<{
      nodes: string;
      sources: string;
      claims: string;
      sourceLinks: string;
    }>(
      `SELECT
        (SELECT COUNT(*)::text FROM "nodes" WHERE "user_id" = $1) AS "nodes",
        (SELECT COUNT(*)::text FROM "sources" WHERE "user_id" = $1) AS "sources",
        (SELECT COUNT(*)::text FROM "claims" WHERE "user_id" = $1) AS "claims",
        (SELECT COUNT(*)::text FROM "source_links") AS "sourceLinks"`,
      [userId],
    );
    expect(counts.rows[0]).toEqual({
      nodes: "0",
      sources: "1",
      claims: "0",
      sourceLinks: "0",
    });
    await expect(
      rootClient.query(
        `SELECT "state" FROM "source_tombstones" WHERE "user_id" = $1 AND "source_id" = $2`,
        [userId, sourceId],
      ),
    ).resolves.toMatchObject({ rows: [{ state: "tombstoned" }] });
  });

  it("preserves converted text when the original blob is absent", async () => {
    const userId = "user_prune_converted_file";
    const sourceId = newTypeId("source");
    await rootClient.query('INSERT INTO "users" ("id") VALUES ($1)', [userId]);
    await seedSource(rootClient, { sourceId, userId, blobBacked: true });
    await rootClient.query(
      'UPDATE "sources" SET "metadata" = $1 WHERE "id" = $2',
      [
        {
          convertedMarkdown: "# Retained document text",
          convertedToMarkdown: true,
        },
        sourceId,
      ],
    );
    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes(
      { userId, dryRun: false, limit: 10 },
      database,
      blobStoreWithExistingSources([]),
    );
    expect(result.sourceScanCount).toBe(1);
    expect(result.missingBlobSourceCandidateCount).toBe(0);
    expect(result.deletedMissingBlobSourceCount).toBe(0);
    expect(
      await rootClient.query(
        'SELECT "deleted_at" FROM "sources" WHERE "id" = $1',
        [sourceId],
      ),
    ).toMatchObject({ rows: [{ deleted_at: null }] });
  });

  it("preserves blob-backed sources whose objects still exist", async () => {
    const userId = "user_prune_existing_blob";
    const sourceId = newTypeId("source");

    await rootClient.query(
      `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
      [userId],
    );
    await seedSource(rootClient, { sourceId, userId, blobBacked: true });

    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes(
      { userId, dryRun: false, limit: 10 },
      database,
      blobStoreWithExistingSources([sourceId]),
    );

    expect(result.sourceScanCount).toBe(1);
    expect(result.missingBlobSourceCandidateCount).toBe(0);
    expect(result.deletedMissingBlobSourceCount).toBe(0);

    const remaining = await rootClient.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "sources" WHERE "user_id" = $1`,
      [userId],
    );
    expect(remaining.rows[0]?.count).toBe("1");
  });

  it("tombstones a missing leaf child but preserves its missing-blob parent", async () => {
    const userId = "user_prune_missing_parent_leaf";
    const parentSourceId = newTypeId("source");
    const childSourceId = newTypeId("source");
    const parentNodeId = newTypeId("node");
    await seedNode(rootClient, {
      id: parentNodeId,
      userId,
      nodeType: "Concept",
      label: "parent evidence",
    });
    await seedSource(rootClient, {
      sourceId: parentSourceId,
      userId,
      blobBacked: true,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    await seedSource(rootClient, {
      sourceId: childSourceId,
      userId,
      blobBacked: true,
      parentSourceId,
      createdAt: new Date("2025-01-02T00:00:00Z"),
    });
    await rootClient.query(
      `INSERT INTO "source_links" ("id", "source_id", "node_id")
       VALUES ($1, $2, $3)`,
      [newTypeId("source_link"), parentSourceId, parentNodeId],
    );
    await rootClient.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_value", "predicate",
        "statement", "source_id", "scope", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, 'value', 'RELATED_TO', 'Parent evidence', $4, 'personal', 'user', now())`,
      [newTypeId("claim"), userId, parentNodeId, parentSourceId],
    );

    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes(
      {
        userId,
        dryRun: false,
        sourceScanLimit: 10,
        limit: 10,
      },
      database,
      blobStoreWithExistingSources([]),
    );

    expect(result.missingBlobSourceCandidateCount).toBe(2);
    expect(result.deletedMissingBlobSourceCount).toBe(1);
    await expect(
      rootClient.query<{
        deleted_at: Date | null;
        content_type: string | null;
        parent_source: string | null;
      }>(
        `SELECT "deleted_at", "content_type", "parent_source"
           FROM "sources"
          WHERE "id" IN ($1, $2)
          ORDER BY "id"`,
        [parentSourceId, childSourceId],
      ),
    ).resolves.toMatchObject({
      rows: expect.arrayContaining([
        { deleted_at: null, content_type: "text/plain", parent_source: null },
        {
          deleted_at: expect.any(Date),
          content_type: null,
          parent_source: parentSourceId,
        },
      ]),
    });
    expect(
      await rootClient.query(
        `SELECT COUNT(*)::text AS count
           FROM "claims"
          WHERE "source_id" = $1`,
        [parentSourceId],
      ),
    ).toMatchObject({ rows: [{ count: "1" }] });
  });

  it("preserves a missing-blob parent when its child blob still exists", async () => {
    const userId = "user_prune_valid_child_parent";
    const parentSourceId = newTypeId("source");
    const childSourceId = newTypeId("source");
    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
    await seedSource(rootClient, {
      sourceId: parentSourceId,
      userId,
      blobBacked: true,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    await seedSource(rootClient, {
      sourceId: childSourceId,
      userId,
      blobBacked: true,
      parentSourceId,
      createdAt: new Date("2025-01-02T00:00:00Z"),
    });

    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");
    const result = await pruneOrphanNodes(
      {
        userId,
        dryRun: false,
        sourceScanLimit: 10,
      },
      database,
      blobStoreWithExistingSources([childSourceId]),
    );

    expect(result.missingBlobSourceCandidateCount).toBe(1);
    expect(result.deletedMissingBlobSourceCount).toBe(0);
    expect(
      await rootClient.query(
        `SELECT "deleted_at", "content_type" FROM "sources"
          WHERE "id" IN ($1, $2)`,
        [parentSourceId, childSourceId],
      ),
    ).toMatchObject({
      rows: expect.arrayContaining([
        { deleted_at: null, content_type: "text/plain" },
        { deleted_at: null, content_type: "text/plain" },
      ]),
    });
  });

  it("rechecks orphan evidence after a concurrent claim or self marker", async () => {
    const { pruneOrphanNodes } = await import("./prune-orphan-nodes");

    async function waitForNodeLockWaiter(
      inspector: Client,
      prunerPid: number,
    ): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await inspector.query(
          `SELECT 1
             FROM pg_stat_activity
            WHERE pid = $1
              AND wait_event_type = 'Lock'
              AND query ILIKE '%for update%'
            LIMIT 1`,
          [prunerPid],
        );
        if (waiting.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("orphan-node row-lock waiter did not reach the barrier");
    }

    async function runRace(
      mutate: (locker: Client, nodeId: TypeId<"node">) => Promise<void>,
    ): Promise<TypeId<"node">> {
      const nodeId = newTypeId("node");
      await seedNode(rootClient, {
        id: nodeId,
        userId: "user_orphan_recheck",
        nodeType: "Concept",
        label: "orphan recheck",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      });
      const locker = new Client({ connectionString: dsnFor(dbName) });
      const pruner = new Client({ connectionString: dsnFor(dbName) });
      await locker.connect();
      await pruner.connect();
      const prunerDb = drizzle(pruner, { schema, casing: "snake_case" });
      try {
        await locker.query("BEGIN");
        await locker.query(
          `SELECT "id" FROM "nodes" WHERE "id" = $1 FOR UPDATE`,
          [nodeId],
        );
        const pidResult = await pruner.query<{ pid: string }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const prunePromise = pruneOrphanNodes(
          {
            userId: "user_orphan_recheck",
            dryRun: false,
            limit: 1,
          },
          prunerDb,
          blobStoreWithExistingSources([]),
        );
        await waitForNodeLockWaiter(rootClient, Number(pidResult.rows[0]?.pid));
        await mutate(locker, nodeId);
        await locker.query("COMMIT");
        const result = await prunePromise;
        expect(result.deletedCount).toBe(0);
        return nodeId;
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await locker.end();
        await pruner.end();
      }
    }

    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
      "user_orphan_recheck",
    ]);
    const claimSourceId = newTypeId("source");
    await rootClient.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "metadata")
       VALUES ($1, $2, 'conversation', $3, 'personal', '{}'::jsonb)`,
      [claimSourceId, "user_orphan_recheck", `recheck:${claimSourceId}`],
    );
    const claimedNodeId = await runRace(async (locker, nodeId) => {
      await locker.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate",
           "statement", "source_id", "scope", "asserted_by_kind", "stated_at"
         ) VALUES ($1, $2, $3, 'value', 'RELATED_TO', 'new orphan evidence', $4, 'personal', 'user', now())`,
        [newTypeId("claim"), "user_orphan_recheck", nodeId, claimSourceId],
      );
    });
    await expect(
      rootClient.query(
        `SELECT COUNT(*)::text AS count FROM "claims" WHERE "subject_node_id" = $1`,
        [claimedNodeId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: "1" }] });

    await rootClient.query(
      `TRUNCATE "aliases", "claims", "source_links", "user_profiles",
                "node_metadata", "nodes", "sources", "users" CASCADE`,
    );
    const markedNodeId = await runRace(async (locker, nodeId) => {
      await locker.query(
        `UPDATE "node_metadata"
            SET "additional_data" = '{"isUserSelf":true}'::jsonb
          WHERE "node_id" = $1`,
        [nodeId],
      );
    });
    await expect(
      rootClient.query<{ additional_data: Record<string, unknown> }>(
        `SELECT "additional_data" FROM "node_metadata" WHERE "node_id" = $1`,
        [markedNodeId],
      ),
    ).resolves.toMatchObject({
      rows: [{ additional_data: { isUserSelf: true } }],
    });
  });

  it("uses one global node/source budget across active workspace partitions", async () => {
    const userId = "user_prune_workspace_global";
    const foreignUserId = "user_prune_workspace_foreign";
    const partitionA = "room:orphan-a";
    const partitionB = "room:orphan-b";
    const inactivePartition = "room:orphan-inactive";
    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1), ($2)`, [
      userId,
      foreignUserId,
    ]);
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES
         ($1, $3, 'active'),
         ($1, $4, 'active'),
         ($1, $5, 'quarantined'),
         ($2, $3, 'active')`,
      [userId, foreignUserId, partitionA, partitionB, inactivePartition],
    );
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrated'), ($2, 'migrated')`,
      [userId, foreignUserId],
    );

    const oldNodeB = newTypeId("node");
    const newerNodeA = newTypeId("node");
    const inactiveNode = newTypeId("node");
    const foreignNode = newTypeId("node");
    await seedNode(rootClient, {
      id: oldNodeB,
      userId,
      partitionKey: partitionB,
      nodeType: "Concept",
      label: "old B",
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    await seedNode(rootClient, {
      id: newerNodeA,
      userId,
      partitionKey: partitionA,
      nodeType: "Concept",
      label: "newer A",
      createdAt: new Date("2025-02-01T00:00:00Z"),
    });
    await rootClient.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await seedNode(rootClient, {
        id: inactiveNode,
        userId,
        partitionKey: inactivePartition,
        nodeType: "Concept",
        label: "inactive",
        createdAt: new Date("2024-01-01T00:00:00Z"),
      });
    } finally {
      await rootClient.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }
    await seedNode(rootClient, {
      id: foreignNode,
      userId: foreignUserId,
      partitionKey: partitionA,
      nodeType: "Concept",
      label: "foreign",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    const oldSourceA = newTypeId("source");
    const newerSourceB = newTypeId("source");
    await seedSource(rootClient, {
      sourceId: oldSourceA,
      userId,
      partitionKey: partitionA,
      blobBacked: true,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    await seedSource(rootClient, {
      sourceId: newerSourceB,
      userId,
      partitionKey: partitionB,
      blobBacked: true,
      createdAt: new Date("2025-02-01T00:00:00Z"),
    });

    const { pruneOrphanNodesWorkspace } = await import("./prune-orphan-nodes");
    const blobStore = blobStoreWithExistingSources([]);
    const dryRun = await pruneOrphanNodesWorkspace(
      {
        userId,
        limit: 1,
        sourceScanLimit: 1,
        sampleLimit: 10,
      },
      database,
      blobStore,
    );
    expect(dryRun.sourceScanCount).toBe(1);
    expect(dryRun.sourceScanHasMore).toBe(true);
    expect(dryRun.missingBlobSourceCandidateCount).toBe(1);
    expect(dryRun.missingBlobSources.map((source) => source.id)).toEqual([
      oldSourceA,
    ]);
    expect(dryRun.candidates.map((node) => node.id)).toEqual([oldNodeB]);
    expect(dryRun.hasMore).toBe(true);
    expect(dryRun.deletedCount).toBe(0);

    const applied = await pruneOrphanNodesWorkspace(
      {
        userId,
        dryRun: false,
        limit: 1,
        sourceScanLimit: 1,
        sampleLimit: 10,
      },
      database,
      blobStore,
    );
    expect(applied.deletedMissingBlobSourceCount).toBe(1);
    expect(applied.deletedCount).toBe(1);
    expect(applied.hasMore).toBe(true);
    expect(
      await rootClient.query(
        `SELECT "deleted_at", "metadata" FROM "sources" WHERE "id" = $1`,
        [oldSourceA],
      ),
    ).toMatchObject({ rows: [{ deleted_at: expect.any(Date), metadata: {} }] });
    expect(
      await rootClient.query(
        `SELECT "deleted_at" FROM "sources" WHERE "id" = $1`,
        [newerSourceB],
      ),
    ).toMatchObject({ rows: [{ deleted_at: null }] });
    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" ORDER BY "id"`,
    );
    expect(remaining.rows.map((node) => node.id)).toEqual(
      expect.arrayContaining([newerNodeA, inactiveNode, foreignNode]),
    );
    expect(remaining.rows.map((node) => node.id)).not.toContain(oldNodeB);
  });

  it("rolls back earlier lifecycle tombstones when a later source conflicts", async () => {
    const userId = "user_prune_workspace_rollback";
    const partitionA = "room:rollback-a";
    const partitionB = "room:rollback-b";
    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES ($1, $2, 'active'), ($1, $3, 'active')`,
      [userId, partitionA, partitionB],
    );
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrated')`,
      [userId],
    );
    const firstSource = newTypeId("source");
    const conflictingSource = newTypeId("source");
    await seedSource(rootClient, {
      sourceId: firstSource,
      userId,
      partitionKey: partitionA,
      blobBacked: true,
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    await seedSource(rootClient, {
      sourceId: conflictingSource,
      userId,
      partitionKey: partitionB,
      blobBacked: true,
      createdAt: new Date("2025-01-02T00:00:00Z"),
    });
    const firstNode = newTypeId("node");
    const secondNode = newTypeId("node");
    await seedNode(rootClient, {
      id: firstNode,
      userId,
      partitionKey: partitionA,
      nodeType: "Concept",
      label: "first source node",
    });
    await seedNode(rootClient, {
      id: secondNode,
      userId,
      partitionKey: partitionB,
      nodeType: "Concept",
      label: "second source node",
    });
    await rootClient.query(
      `INSERT INTO "source_links" ("id", "source_id", "node_id")
       VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        newTypeId("source_link"),
        firstSource,
        firstNode,
        newTypeId("source_link"),
        conflictingSource,
        secondNode,
      ],
    );
    await rootClient.query(
      `INSERT INTO "claims" (
        "id", "user_id", "partition_key", "subject_node_id", "object_value",
        "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, $4, 'value', 'RELATED_TO', 'first claim', $5, 'personal', 'user', now()),
               ($6, $2, $7, $8, 'value', 'RELATED_TO', 'second claim', $9, 'personal', 'user', now())`,
      [
        newTypeId("claim"),
        userId,
        partitionA,
        firstNode,
        firstSource,
        newTypeId("claim"),
        partitionB,
        secondNode,
        conflictingSource,
      ],
    );

    let listCalls = 0;
    const transactionIds: (string | null)[] = [];
    const blobStore: SourceBlobStore = {
      async listBlobSourceIds() {
        listCalls += 1;
        const transactionState = await rootClient.query<{
          txid: string | null;
        }>(`SELECT txid_current_if_assigned() AS txid`);
        transactionIds.push(transactionState.rows[0]?.txid ?? null);
        if (listCalls === 2) {
          await rootClient.query(`ALTER TABLE "sources" DISABLE TRIGGER USER`);
          try {
            await rootClient.query(
              `UPDATE "sources" SET "version" = "version" + 1 WHERE "id" = $1`,
              [conflictingSource],
            );
          } finally {
            await rootClient.query(`ALTER TABLE "sources" ENABLE TRIGGER USER`);
          }
        }
        return new Set<TypeId<"source">>();
      },
    };
    const { pruneOrphanNodesWorkspace } = await import("./prune-orphan-nodes");
    await expect(
      pruneOrphanNodesWorkspace(
        {
          userId,
          dryRun: false,
          limit: 10,
          sourceScanLimit: 10,
        },
        database,
        blobStore,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_VERSION_CONFLICT" });
    expect(listCalls).toBe(2);
    expect(transactionIds).toEqual([null, null]);

    const sourceState = await rootClient.query<{
      id: string;
      deleted_at: Date | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT "id", "deleted_at", "metadata" FROM "sources" WHERE "id" IN ($1, $2) ORDER BY "id"`,
      [firstSource, conflictingSource],
    );
    expect(sourceState.rows).toEqual([
      { id: firstSource, deleted_at: null, metadata: {} },
      { id: conflictingSource, deleted_at: null, metadata: {} },
    ]);
    const receipts = await rootClient.query(
      `SELECT 1 FROM "source_tombstones" WHERE "user_id" = $1`,
      [userId],
    );
    expect(receipts.rows).toHaveLength(0);
    const remainingNodes = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
      [userId],
    );
    expect(remainingNodes.rows.map((node) => node.id).sort()).toEqual(
      [firstNode, secondNode].sort(),
    );
    const remainingClaims = await rootClient.query(
      `SELECT COUNT(*)::text AS count FROM "claims" WHERE "user_id" = $1`,
      [userId],
    );
    expect(remainingClaims.rows[0]?.count).toBe("2");
  });

  it("reads mixed legacy rows in dry-run but rejects their mutation after migration starts", async () => {
    const userId = "user_prune_workspace_mixed";
    const partitionKey = "room:orphan-mixed";
    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES ($1, $2, 'active')`,
      [userId, partitionKey],
    );
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrating')`,
      [userId],
    );
    const activeId = newTypeId("node");
    const legacyId = newTypeId("node");
    await rootClient.query(`ALTER TABLE "nodes" DISABLE TRIGGER USER`);
    try {
      await seedNode(rootClient, {
        id: activeId,
        userId,
        partitionKey,
        nodeType: "Concept",
        label: "active orphan",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      });
      await seedNode(rootClient, {
        id: legacyId,
        userId,
        nodeType: "Concept",
        label: "legacy orphan",
        createdAt: new Date("2025-01-01T00:00:00Z"),
      });
    } finally {
      await rootClient.query(`ALTER TABLE "nodes" ENABLE TRIGGER USER`);
    }

    const { pruneOrphanNodesWorkspace } = await import("./prune-orphan-nodes");
    const dryRun = await pruneOrphanNodesWorkspace(
      { userId, sampleLimit: 10 },
      database,
      blobStoreWithExistingSources([]),
    );
    expect(dryRun.candidateCount).toBe(2);
    expect(dryRun.deletedCount).toBe(0);
    await expect(
      pruneOrphanNodesWorkspace(
        { userId, dryRun: false },
        database,
        blobStoreWithExistingSources([]),
      ),
    ).rejects.toMatchObject({ code: "PARTITION_REQUIRED" });
    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
      [userId],
    );
    expect(remaining.rows.map((node) => node.id).sort()).toEqual(
      [activeId, legacyId].sort(),
    );
  });
});
