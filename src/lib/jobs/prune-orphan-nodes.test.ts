/**
 * DB-integration tests for deterministic orphan node pruning.
 *
 * The job is intentionally not LLM-driven: evidence-free legacy nodes can be
 * deleted mechanically, while anything with claims/source links/aliases must
 * survive.
 */
import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
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

async function createTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "nodes" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "node_type" varchar(50) NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "node_metadata" (
      "id" text PRIMARY KEY NOT NULL,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "label" text,
      "canonical_label" text,
      "description" text,
      "additional_data" jsonb,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      UNIQUE ("node_id")
    );
    CREATE TABLE IF NOT EXISTS "sources" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "type" varchar(50) NOT NULL,
      "external_id" text NOT NULL,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "status" varchar(20) DEFAULT 'completed',
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      UNIQUE ("user_id", "type", "external_id")
    );
    CREATE TABLE IF NOT EXISTS "source_links" (
      "id" text PRIMARY KEY NOT NULL,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "specific_location" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      UNIQUE ("source_id", "node_id")
    );
    CREATE TABLE IF NOT EXISTS "claims" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
      "object_value" text,
      "predicate" varchar(80) NOT NULL,
      "statement" text NOT NULL,
      "description" text,
      "metadata" jsonb,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "asserted_by_kind" varchar(24) NOT NULL,
      "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
      "superseded_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
      "contradicted_by_claim_id" text REFERENCES "claims"("id") ON DELETE SET NULL,
      "stated_at" timestamp with time zone NOT NULL,
      "valid_from" timestamp with time zone,
      "valid_to" timestamp with time zone,
      "status" varchar(30) DEFAULT 'active' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "claims_object_shape_xor_ck"
        CHECK (num_nonnulls("object_node_id", "object_value") = 1)
    );
    CREATE TABLE IF NOT EXISTS "aliases" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "alias_text" text NOT NULL,
      "normalized_alias_text" text NOT NULL,
      "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
    );
  `);
}

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
  args: { sourceId: TypeId<"source">; userId: string },
): Promise<void> {
  await client.query(
    `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope")
     VALUES ($1, $2, 'legacy_migration', $3, 'personal')`,
    [args.sourceId, args.userId, `legacy_migration:${args.userId}`],
  );
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
    await createTables(rootClient);
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

  it("deletes true orphans and preserves nodes with evidence", async () => {
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

    expect(result.candidateCount).toBe(1);
    expect(result.deletedCount).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(result.candidates.map((node) => node.id)).toEqual([orphanId]);

    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
      [userId],
    );
    expect(remaining.rows.map((row) => row.id).sort()).toEqual(
      [claimNodeId, sourceLinkedId, aliasNodeId, speakerNodeId].sort(),
    );
  });
});
