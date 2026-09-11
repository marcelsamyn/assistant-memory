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
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
    [args.userId],
  );
  await client.query(
    `INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at")
     VALUES ($1, $2, $3, $4)`,
    [
      args.id,
      args.userId,
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
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "sources" (
       "id", "user_id", "type", "external_id", "scope", "metadata",
       "content_type", "content_length"
     )
     VALUES ($1, $2, 'legacy_migration', $3, 'personal', '{}'::jsonb, $4, $5)`,
    [
      args.sourceId,
      args.userId,
      `legacy_migration:${args.sourceId}`,
      args.blobBacked ? "text/plain" : null,
      args.blobBacked ? 42 : null,
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
});
