import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;

process.env["DATABASE_URL"] ??= adminDsn();
process.env["JINA_API_KEY"] ??= "test";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

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

describeIfServer("getCommitment detail query", () => {
  const dbName = `memory_commitment_detail_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
  });

  afterAll(async () => {
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

  it("returns full detail with status history, owner reassignment, due change, and manual source", async () => {
    const userId = "user_commitment_detail";

    const taskNodeId = newTypeId("node");
    const ownerOrigId = newTypeId("node"); // Alice
    const ownerNewId = newTypeId("node"); // Bob
    const dateOrigId = newTypeId("node"); // 2026-03-01
    const dateNewId = newTypeId("node"); // 2026-04-15

    // Two sources: one manual (from direct task creation), one document
    const manualSourceId = newTypeId("source");
    const docSourceId = newTypeId("source");

    // Claim ids to check
    const claimPendingId = newTypeId("claim"); // superseded
    const claimInProgressId = newTypeId("claim"); // superseded
    const claimDoneId = newTypeId("claim"); // active HAS_TASK_STATUS
    const claimOwnerAliceId = newTypeId("claim"); // superseded OWNED_BY
    const claimOwnerBobId = newTypeId("claim"); // active OWNED_BY
    const claimDueOrigId = newTypeId("claim"); // superseded DUE_ON
    const claimDueNewId = newTypeId("claim"); // active DUE_ON

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      // Provision full schema including all columns getNodeById/loadSources need.
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "node_metadata" (
          "id" text PRIMARY KEY NOT NULL,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "label" text,
          "canonical_label" text,
          "description" text,
          "additional_data" jsonb,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
        );
        CREATE TABLE "sources" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "type" varchar(50) NOT NULL,
          "external_id" text NOT NULL,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "status" varchar(20) DEFAULT 'completed',
          "metadata" jsonb,
          "last_ingested_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "source_links" (
          "id" text PRIMARY KEY NOT NULL,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "specific_location" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
        );
        CREATE TABLE "aliases" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "alias_text" text NOT NULL,
          "normalized_alias_text" text NOT NULL,
          "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "aliases_user_normalized_canonical_unique" UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
        );
        CREATE TABLE "claims" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_value" text,
          "predicate" varchar(80) NOT NULL,
          "statement" text NOT NULL,
          "description" text,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "asserted_by_kind" varchar(24) NOT NULL,
          "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
          "stated_at" timestamp with time zone NOT NULL,
          "status" varchar(30) DEFAULT 'active' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      // Sources — insert separately to keep sequential params unambiguous
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES ($1, $2, 'manual', $3, 'personal')`,
        [manualSourceId, userId, `manual:${userId}`],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "metadata")
         VALUES ($1, $2, 'document', $3, 'personal', '{"title": "Some Document"}'::jsonb)`,
        [docSourceId, userId, `doc:${userId}`],
      );

      // Nodes — $1..5 = task/ownerOrig/ownerNew/dateOrig/dateNew, $6 = userId
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at")
         VALUES
           ($1, $6, 'Task',     '2026-02-01T00:00:00Z'),
           ($2, $6, 'Person',   '2026-02-01T00:00:00Z'),
           ($3, $6, 'Person',   '2026-02-01T00:00:00Z'),
           ($4, $6, 'Temporal', '2026-02-01T00:00:00Z'),
           ($5, $6, 'Temporal', '2026-02-01T00:00:00Z')`,
        [taskNodeId, ownerOrigId, ownerNewId, dateOrigId, dateNewId, userId],
      );

      // Node metadata — one at a time to keep params clean
      const metaRows = [
        [taskNodeId, "Detail task", "detail task", "A task for detail testing"],
        [ownerOrigId, "Alice", "alice", null],
        [ownerNewId, "Bob", "bob", null],
        [dateOrigId, "2026-03-01", "2026-03-01", null],
        [dateNewId, "2026-04-15", "2026-04-15", null],
      ] as const;

      for (const [nodeId, label, canonical, desc] of metaRows) {
        await client.query(
          `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
           VALUES ($1, $2, $3, $4, $5)`,
          [newTypeId("node_metadata"), nodeId, label, canonical, desc],
        );
      }

      // Status history: pending (superseded) → in_progress (superseded) → done (active)
      // $1=claimPending,$2=claimInProgress,$3=claimDone,$4=userId,$5=taskNodeId,$6=manualSourceId
      await client.query(
        `INSERT INTO "claims" ("id","user_id","subject_node_id","object_value","predicate","statement","source_id","scope","asserted_by_kind","stated_at","status")
         VALUES
           ($1,$4,$5,'pending',    'HAS_TASK_STATUS','Task is pending.',    $6,'personal','user','2026-02-01T10:00:00Z','superseded'),
           ($2,$4,$5,'in_progress','HAS_TASK_STATUS','Task is in progress.',$6,'personal','user','2026-02-10T10:00:00Z','superseded'),
           ($3,$4,$5,'done',       'HAS_TASK_STATUS','Task is done.',       $6,'personal','user','2026-03-01T10:00:00Z','active')`,
        [
          claimPendingId,
          claimInProgressId,
          claimDoneId,
          userId,
          taskNodeId,
          manualSourceId,
        ],
      );

      // Owner history: Alice (superseded) → Bob (active)
      // $1=claimOwnerAlice,$2=claimOwnerBob,$3=userId,$4=taskNodeId,$5=ownerOrigId,$6=ownerNewId,$7=manualSourceId
      await client.query(
        `INSERT INTO "claims" ("id","user_id","subject_node_id","object_node_id","predicate","statement","source_id","scope","asserted_by_kind","stated_at","status")
         VALUES
           ($1,$3,$4,$5,'OWNED_BY','Task owned by Alice.',$7,'personal','user','2026-02-01T10:01:00Z','superseded'),
           ($2,$3,$4,$6,'OWNED_BY','Task owned by Bob.',  $7,'personal','user','2026-02-15T10:01:00Z','active')`,
        [
          claimOwnerAliceId,
          claimOwnerBobId,
          userId,
          taskNodeId,
          ownerOrigId,
          ownerNewId,
          manualSourceId,
        ],
      );

      // Due date history: 2026-03-01 (superseded) → 2026-04-15 (active)
      // $1=claimDueOrig,$2=claimDueNew,$3=userId,$4=taskNodeId,$5=dateOrigId,$6=dateNewId,$7=docSourceId
      await client.query(
        `INSERT INTO "claims" ("id","user_id","subject_node_id","object_node_id","predicate","statement","source_id","scope","asserted_by_kind","stated_at","status")
         VALUES
           ($1,$3,$4,$5,'DUE_ON','Task due 2026-03-01.',$7,'personal','user','2026-02-01T10:02:00Z','superseded'),
           ($2,$3,$4,$6,'DUE_ON','Task due 2026-04-15.',$7,'personal','user','2026-02-20T10:02:00Z','active')`,
        [
          claimDueOrigId,
          claimDueNewId,
          userId,
          taskNodeId,
          dateOrigId,
          dateNewId,
          docSourceId,
        ],
      );

      const { getCommitment } = await import("./commitment-detail");

      // --- Full detail ---
      const detail = await getCommitment({
        userId,
        taskId: taskNodeId,
        includeHistory: true,
        includeSources: true,
      });

      expect(detail.taskId).toBe(taskNodeId);
      expect(detail.label).toBe("Detail task");
      expect(detail.description).toBe("A task for detail testing");

      // Active status is "done" from the latest claim
      expect(detail.status).toBe("done");
      expect(detail.statusClaimId).toBe(claimDoneId);
      expect(detail.statusStatedAt).toEqual(new Date("2026-03-01T10:00:00Z"));

      // Active owner is Bob
      expect(detail.owner).toMatchObject({
        nodeId: ownerNewId,
        label: "Bob",
        claimId: claimOwnerBobId,
      });

      // Active due date is 2026-04-15
      expect(detail.dueOn).toBe("2026-04-15");
      expect(detail.dueClaimId).toBe(claimDueNewId);

      // History contains all 7 lifecycle claims (3 status + 2 owner + 2 due), sorted statedAt desc
      expect(detail.history).toHaveLength(7);
      const historyStatedAts = detail.history.map((h) => h.statedAt.getTime());
      expect(historyStatedAts).toEqual(
        [...historyStatedAts].sort((a, b) => b - a),
      );

      // The superseded entries are present in history
      const historyClaimIds = detail.history.map((h) => h.claimId);
      expect(historyClaimIds).toContain(claimPendingId);
      expect(historyClaimIds).toContain(claimInProgressId);
      expect(historyClaimIds).toContain(claimOwnerAliceId);
      expect(historyClaimIds).toContain(claimDueOrigId);

      // --- Sources: both manual and document are included, de-duplicated ---
      // The claims reference both manualSourceId and docSourceId, so both appear.
      // Crucially, the manual source must NOT be dropped (manual is a valid type for commitments).
      expect(detail.sources.length).toBeGreaterThanOrEqual(2);
      const sourceIds = detail.sources.map((s) => s.sourceId);
      // No duplicates
      expect(new Set(sourceIds).size).toBe(sourceIds.length);
      const sourceTypes = detail.sources.map((s) => s.type);
      expect(sourceTypes).toContain("manual");
      expect(sourceTypes).toContain("document");

      // --- includeHistory: false → empty history ---
      const noHistory = await getCommitment({
        userId,
        taskId: taskNodeId,
        includeHistory: false,
        includeSources: true,
      });
      expect(noHistory.history).toEqual([]);
      // Current state still present
      expect(noHistory.status).toBe("done");
      expect(noHistory.owner?.nodeId).toBe(ownerNewId);

      // --- includeSources: false → empty sources ---
      const noSources = await getCommitment({
        userId,
        taskId: taskNodeId,
        includeHistory: true,
        includeSources: false,
      });
      expect(noSources.sources).toEqual([]);
      // History still present
      expect(noSources.history).toHaveLength(7);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws TaskNotFoundError for a non-Task node id", async () => {
    const userId = "user_detail_nontask";
    const personNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    // Use a separate DB so table creation is clean for this test
    const dbName2 = `memory_cd_nontask_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName2}"`);
    await admin.end();

    const client = new Client({ connectionString: dsnFor(dbName2) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "node_metadata" (
          "id" text PRIMARY KEY NOT NULL,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "label" text,
          "canonical_label" text,
          "description" text,
          "additional_data" jsonb,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
        );
        CREATE TABLE "sources" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "type" varchar(50) NOT NULL,
          "external_id" text NOT NULL,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "status" varchar(20) DEFAULT 'completed',
          "metadata" jsonb,
          "last_ingested_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "source_links" (
          "id" text PRIMARY KEY NOT NULL,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "specific_location" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
        );
        CREATE TABLE "aliases" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "alias_text" text NOT NULL,
          "normalized_alias_text" text NOT NULL,
          "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "aliases_user_normalized_canonical_unique" UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
        );
        CREATE TABLE "claims" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_value" text,
          "predicate" varchar(80) NOT NULL,
          "statement" text NOT NULL,
          "description" text,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "asserted_by_kind" varchar(24) NOT NULL,
          "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
          "stated_at" timestamp with time zone NOT NULL,
          "status" varchar(30) DEFAULT 'active' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id") VALUES ($1, $2, 'manual', $3)`,
        [sourceId, userId, `manual:${userId}`],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [personNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, $3, $4)`,
        [newTypeId("node_metadata"), personNodeId, "A person", "a person"],
      );

      const { getCommitment } = await import("./commitment-detail");
      const { TaskNotFoundError } = await import("~/lib/commitments");

      await expect(
        getCommitment({
          userId,
          taskId: personNodeId,
          includeHistory: true,
          includeSources: true,
        }),
      ).rejects.toBeInstanceOf(TaskNotFoundError);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();

      // Clean up the per-test DB
      const cleanupAdmin = new Client({ connectionString: adminDsn() });
      await cleanupAdmin.connect();
      await cleanupAdmin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName2],
      );
      await cleanupAdmin.query(`DROP DATABASE IF EXISTS "${dbName2}"`);
      await cleanupAdmin.end();
    }
  });
});
