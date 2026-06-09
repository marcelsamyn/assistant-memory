/**
 * DB-integration tests for the deterministic staleness sweep.
 *
 * Like prune-orphan-nodes these run against a throwaway Postgres database and
 * skip when no server is reachable. They pin the scoring/threshold behavior and
 * the protection rules (recency floor, open tasks, self identity, reference
 * scope) that keep the sweep from eating live memory.
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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number): Date => new Date(Date.now() - days * DAY_MS);

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
      "metadata" jsonb,
      "last_ingested_at" timestamp with time zone,
      "status" varchar(20) DEFAULT 'completed',
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "deleted_at" timestamp with time zone,
      "content_type" varchar(100),
      "content_length" integer,
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
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "content" text NOT NULL,
      "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

const USER_ID = "user_stale_sweep";

async function ensureUser(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
    [USER_ID],
  );
}

async function seedNode(
  client: Client,
  args: {
    id: TypeId<"node">;
    nodeType: string;
    label: string;
    createdAt: Date;
  },
): Promise<void> {
  await ensureUser(client);
  await client.query(
    `INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at")
     VALUES ($1, $2, $3, $4)`,
    [args.id, USER_ID, args.nodeType, args.createdAt],
  );
  await client.query(
    `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
     VALUES ($1, $2, $3, lower($3))`,
    [newTypeId("node_metadata"), args.id, args.label],
  );
}

let sharedSourceId: TypeId<"source"> | null = null;
async function seedSourceOnce(client: Client): Promise<TypeId<"source">> {
  if (sharedSourceId) return sharedSourceId;
  const sourceId = newTypeId("source");
  await ensureUser(client);
  await client.query(
    `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "metadata")
     VALUES ($1, $2, 'conversation', $3, 'personal', '{}'::jsonb)`,
    [sourceId, USER_ID, `ext:${sourceId}`],
  );
  sharedSourceId = sourceId;
  return sourceId;
}

async function seedClaim(
  client: Client,
  args: {
    subjectNodeId: TypeId<"node">;
    predicate: string;
    objectValue: string;
    statedAt: Date;
    status?: string;
    scope?: string;
    assertedByKind?: string;
  },
): Promise<void> {
  const sourceId = await seedSourceOnce(client);
  await client.query(
    `INSERT INTO "claims" (
       "id", "user_id", "subject_node_id", "object_value", "predicate",
       "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      newTypeId("claim"),
      USER_ID,
      args.subjectNodeId,
      args.objectValue,
      args.predicate,
      `${args.predicate} ${args.objectValue}`,
      sourceId,
      args.scope ?? "personal",
      args.assertedByKind ?? "user",
      args.statedAt,
      args.status ?? "active",
    ],
  );
}

async function seedSelfAlias(
  client: Client,
  args: { nodeId: TypeId<"node">; alias: string },
): Promise<void> {
  await ensureUser(client);
  await client.query(
    `INSERT INTO "aliases" ("id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id")
     VALUES ($1, $2, $3, $4, $5)`,
    [
      newTypeId("alias"),
      USER_ID,
      args.alias,
      args.alias.trim().toLowerCase(),
      args.nodeId,
    ],
  );
  await client.query(
    `INSERT INTO "user_profiles" ("id", "user_id", "content", "metadata")
     VALUES ($1, $2, '', $3::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      newTypeId("user_profile"),
      USER_ID,
      JSON.stringify({ userSelfAliases: [args.alias] }),
    ],
  );
}

async function nodeCount(client: Client): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "nodes" WHERE "user_id" = $1`,
    [USER_ID],
  );
  return Number(res.rows[0]?.count ?? "0");
}

describeIfServer("pruneStaleNodes", () => {
  const dbName = `memory_prune_stale_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  let database: TestDb;
  let rootClient: Client;

  // Distinct node fixtures reused across cases.
  const staleId = newTypeId("node"); // old, no evidence -> high score
  const recentId = newTypeId("node"); // recent -> protected by recency floor
  const strongId = newTypeId("node"); // old but well-connected -> survives
  const openTaskId = newTypeId("node"); // old task, open -> protected
  const selfId = newTypeId("node"); // self identity -> protected
  const referenceId = newTypeId("node"); // reference scope -> protected by default

  async function seedGraph(): Promise<void> {
    sharedSourceId = null;
    await seedNode(rootClient, {
      id: staleId,
      nodeType: "Concept",
      label: "stale concept",
      createdAt: daysAgo(400),
    });
    await seedNode(rootClient, {
      id: recentId,
      nodeType: "Concept",
      label: "recent concept",
      createdAt: daysAgo(5),
    });
    await seedNode(rootClient, {
      id: strongId,
      nodeType: "Concept",
      label: "strong concept",
      createdAt: daysAgo(400),
    });
    for (let i = 0; i < 3; i += 1) {
      await seedClaim(rootClient, {
        subjectNodeId: strongId,
        predicate: "HAS_ATTRIBUTE",
        objectValue: `attr-${i}`,
        statedAt: daysAgo(400),
        assertedByKind: "user",
      });
    }
    await seedNode(rootClient, {
      id: openTaskId,
      nodeType: "Task",
      label: "open task",
      createdAt: daysAgo(400),
    });
    await seedClaim(rootClient, {
      subjectNodeId: openTaskId,
      predicate: "HAS_TASK_STATUS",
      objectValue: "pending",
      statedAt: daysAgo(400),
      assertedByKind: "user",
    });
    await seedNode(rootClient, {
      id: selfId,
      nodeType: "Person",
      label: "Marcel",
      createdAt: daysAgo(400),
    });
    await seedSelfAlias(rootClient, { nodeId: selfId, alias: "Marcel" });
    await seedNode(rootClient, {
      id: referenceId,
      nodeType: "Concept",
      label: "reference concept",
      createdAt: daysAgo(400),
    });
    await seedClaim(rootClient, {
      subjectNodeId: referenceId,
      predicate: "HAS_ATTRIBUTE",
      objectValue: "from a book",
      statedAt: daysAgo(400),
      scope: "reference",
      assertedByKind: "document_author",
    });
  }

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
      `TRUNCATE "aliases", "claims", "source_links", "user_profiles",
              "node_metadata", "nodes", "sources", "users" CASCADE`,
    );
  });

  it("dry run scores stale nodes but protects recent/connected/task/self/reference nodes", async () => {
    await seedGraph();
    const { pruneStaleNodes } = await import("./prune-stale-nodes");

    const result = await pruneStaleNodes({ userId: USER_ID }, database);

    expect(result.dryRun).toBe(true);
    expect(result.appliedThreshold).toBeCloseTo(0.5);
    expect(result.scannedCount).toBe(6);
    expect(result.candidateCount).toBe(1);
    expect(result.deletedCount).toBe(0);
    expect(result.candidates.map((node) => node.id)).toEqual([staleId]);
    expect(result.candidates[0]?.score).toBe(1);
    expect(result.candidates[0]?.reasons.join(" ")).toContain("no evidence");

    // Nothing deleted on a dry run.
    expect(await nodeCount(rootClient)).toBe(6);
  });

  it("apply deletes candidates and leaves protected nodes intact", async () => {
    await seedGraph();
    const { pruneStaleNodes } = await import("./prune-stale-nodes");

    const result = await pruneStaleNodes(
      { userId: USER_ID, dryRun: false },
      database,
    );

    expect(result.dryRun).toBe(false);
    expect(result.deletedCount).toBe(1);
    expect(result.hasMore).toBe(false);

    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
      [USER_ID],
    );
    const remainingIds = remaining.rows.map((row) => row.id).sort();
    expect(remainingIds).toEqual(
      [recentId, strongId, openTaskId, selfId, referenceId].sort(),
    );
  });

  it("includeReference brings reference nodes into scope", async () => {
    await seedGraph();
    const { pruneStaleNodes } = await import("./prune-stale-nodes");

    const result = await pruneStaleNodes(
      { userId: USER_ID, includeReference: true },
      database,
    );

    expect(result.candidateCount).toBe(2);
    expect(result.candidates.map((node) => node.id).sort()).toEqual(
      [staleId, referenceId].sort(),
    );
  });

  it("higher aggressiveness lowers the threshold and catches weak-but-connected nodes", async () => {
    await seedGraph();
    const { pruneStaleNodes } = await import("./prune-stale-nodes");

    const result = await pruneStaleNodes(
      { userId: USER_ID, aggressiveness: 0.55 },
      database,
    );

    expect(result.appliedThreshold).toBeCloseTo(0.45);
    expect(result.candidates.map((node) => node.id).sort()).toEqual(
      [staleId, strongId].sort(),
    );
  });
});
