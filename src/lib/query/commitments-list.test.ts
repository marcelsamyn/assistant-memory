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

describeIfServer("listCommitments query", () => {
  const dbName = `memory_list_commitments_test_${Date.now()}_${Math.floor(
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

  it("filters, sorts, searches, and paginates correctly", async () => {
    const userId = "user_list_commitments";

    // Task nodes
    const taskPendingId = newTypeId("node");
    const taskInProgressId = newTypeId("node");
    const taskDoneId = newTypeId("node");
    const taskAbandonedId = newTypeId("node");
    const taskCandidateId = newTypeId("node");
    const taskUnownedId = newTypeId("node");

    // Owner nodes
    const ownerAliceId = newTypeId("node");
    const ownerBobId = newTypeId("node");

    // Due date (Temporal) nodes
    const dateEarlyId = newTypeId("node"); // 2026-01-10
    const dateLateId = newTypeId("node"); // 2026-06-20

    // Sources
    const personalSourceId = newTypeId("source");
    const inferredSourceId = newTypeId("source");

    // Claim ids we need to capture for assertions
    const claimPendingStatusId = newTypeId("claim");
    const claimInProgressStatusId = newTypeId("claim");
    const claimDoneStatusId = newTypeId("claim");
    const claimAbandonedStatusId = newTypeId("claim");
    const claimCandidateStatusId = newTypeId("claim");
    const claimUnownedStatusId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
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
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "claims" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_value" text,
          "predicate" varchar(80) NOT NULL,
          "statement" text NOT NULL,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "asserted_by_kind" varchar(24) NOT NULL,
          "stated_at" timestamp with time zone NOT NULL,
          "status" varchar(30) DEFAULT 'active' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      // Sources
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope")
         VALUES
           ($1, $3, 'manual', 'manual:list_test', 'personal'),
           ($2, $3, 'manual', 'inferred:list_test', 'personal')`,
        [personalSourceId, inferredSourceId, userId],
      );

      // Nodes: tasks, owners, due-date temporals
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type", "created_at")
         VALUES
           ($1,  $9, 'Task',     '2026-01-01T00:00:00Z'),
           ($2,  $9, 'Task',     '2026-01-02T00:00:00Z'),
           ($3,  $9, 'Task',     '2026-01-03T00:00:00Z'),
           ($4,  $9, 'Task',     '2026-01-04T00:00:00Z'),
           ($5,  $9, 'Task',     '2026-01-05T00:00:00Z'),
           ($6,  $9, 'Task',     '2026-01-06T00:00:00Z'),
           ($7,  $9, 'Person',   '2026-01-01T00:00:00Z'),
           ($8,  $9, 'Person',   '2026-01-01T00:00:00Z'),
           ($10, $9, 'Temporal', '2026-01-01T00:00:00Z'),
           ($11, $9, 'Temporal', '2026-01-01T00:00:00Z')`,
        [
          taskPendingId,
          taskInProgressId,
          taskDoneId,
          taskAbandonedId,
          taskCandidateId,
          taskUnownedId,
          ownerAliceId,
          ownerBobId,
          userId,
          dateEarlyId,
          dateLateId,
        ],
      );

      // Node metadata (labels)
      const allNodes = [
        [taskPendingId, "Alpha pending task", "alpha pending task"],
        [taskInProgressId, "Beta in-progress task", "beta in-progress task"],
        [taskDoneId, "Gamma done task", "gamma done task"],
        [taskAbandonedId, "Delta abandoned task", "delta abandoned task"],
        [taskCandidateId, "Epsilon candidate task", "epsilon candidate task"],
        [taskUnownedId, "Zeta unowned task", "zeta unowned task"],
        [ownerAliceId, "Alice", "alice"],
        [ownerBobId, "Bob", "bob"],
        [dateEarlyId, "2026-01-10", "2026-01-10"],
        [dateLateId, "2026-06-20", "2026-06-20"],
      ] as const;

      for (const [nodeId, label, canonical] of allNodes) {
        await client.query(
          `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, $3, $4)`,
          [newTypeId("node_metadata"), nodeId, label, canonical],
        );
      }

      // Status claims
      const statusClaims = [
        [
          claimPendingStatusId,
          taskPendingId,
          "pending",
          "user",
          "2026-01-01T10:00:00Z",
        ],
        [
          claimInProgressStatusId,
          taskInProgressId,
          "in_progress",
          "user",
          "2026-01-02T10:00:00Z",
        ],
        [claimDoneStatusId, taskDoneId, "done", "user", "2026-01-03T10:00:00Z"],
        [
          claimAbandonedStatusId,
          taskAbandonedId,
          "abandoned",
          "user",
          "2026-01-04T10:00:00Z",
        ],
        [
          claimCandidateStatusId,
          taskCandidateId,
          "pending",
          "assistant_inferred",
          "2026-01-05T10:00:00Z",
        ],
        [
          claimUnownedStatusId,
          taskUnownedId,
          "pending",
          "user",
          "2026-01-06T10:00:00Z",
        ],
      ] as const;

      for (const [claimId, taskId, status, kind, statedAt] of statusClaims) {
        await client.query(
          `INSERT INTO "claims" ("id", "user_id", "subject_node_id", "object_value", "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status")
           VALUES ($1, $2, $3, $4, 'HAS_TASK_STATUS', $5, $6, 'personal', $7, $8, 'active')`,
          [
            claimId,
            userId,
            taskId,
            status,
            `Task is ${status}.`,
            personalSourceId,
            kind,
            statedAt,
          ],
        );
      }

      // OWNED_BY claims: Alice owns pending+inProgress, Bob owns done
      const ownerClaims = [
        [
          taskPendingId,
          ownerAliceId,
          "Alice owns Alpha.",
          "2026-01-01T10:01:00Z",
        ],
        [
          taskInProgressId,
          ownerAliceId,
          "Alice owns Beta.",
          "2026-01-02T10:01:00Z",
        ],
        [taskDoneId, ownerBobId, "Bob owns Gamma.", "2026-01-03T10:01:00Z"],
      ] as const;

      for (const [taskId, ownerNodeId, stmt, statedAt] of ownerClaims) {
        await client.query(
          `INSERT INTO "claims" ("id", "user_id", "subject_node_id", "object_node_id", "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status")
           VALUES ($1, $2, $3, $4, 'OWNED_BY', $5, $6, 'personal', 'user', $7, 'active')`,
          [
            newTypeId("claim"),
            userId,
            taskId,
            ownerNodeId,
            stmt,
            personalSourceId,
            statedAt,
          ],
        );
      }

      // DUE_ON claims: pending has early date, inProgress has late date
      await client.query(
        `INSERT INTO "claims" ("id", "user_id", "subject_node_id", "object_node_id", "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status")
         VALUES
           ($1, $2, $3, $5, 'DUE_ON', 'Alpha due early.', $7, 'personal', 'user', '2026-01-01T10:02:00Z', 'active'),
           ($4, $2, $6, $8, 'DUE_ON', 'Beta due late.',   $7, 'personal', 'user', '2026-01-02T10:02:00Z', 'active')`,
        [
          newTypeId("claim"),
          userId,
          taskPendingId,
          newTypeId("claim"),
          dateEarlyId,
          taskInProgressId,
          personalSourceId,
          dateLateId,
        ],
      );

      const { listCommitments } = await import("./commitments-list");

      // --- Status filter ---
      const pendingOnly = await listCommitments({
        userId,
        statuses: ["pending"],
        provenance: "all",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      // pending includes: taskPending, taskCandidate, taskUnowned
      expect(pendingOnly.commitments.map((c) => c.status)).toSatisfy(
        (statuses: string[]) => statuses.every((s) => s === "pending"),
      );
      expect(pendingOnly.commitments).toHaveLength(3);

      const doneOrAbandoned = await listCommitments({
        userId,
        statuses: ["done", "abandoned"],
        provenance: "trusted",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(doneOrAbandoned.commitments.map((c) => c.taskId)).toEqual(
        expect.arrayContaining([taskDoneId, taskAbandonedId]),
      );
      expect(doneOrAbandoned.commitments).toHaveLength(2);

      // --- Provenance filter ---
      const trustedOnly = await listCommitments({
        userId,
        provenance: "trusted",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(trustedOnly.commitments.map((c) => c.taskId)).not.toContain(
        taskCandidateId,
      );

      const candidateOnly = await listCommitments({
        userId,
        provenance: "candidate",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(candidateOnly.commitments.map((c) => c.taskId)).toEqual([
        taskCandidateId,
      ]);

      const allProvenance = await listCommitments({
        userId,
        provenance: "all",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(allProvenance.commitments.map((c) => c.taskId)).toContain(
        taskCandidateId,
      );

      // --- ownedBy filter ---
      const aliceTasks = await listCommitments({
        userId,
        ownedBy: ownerAliceId,
        provenance: "trusted",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(aliceTasks.commitments.map((c) => c.taskId)).toEqual(
        expect.arrayContaining([taskPendingId, taskInProgressId]),
      );
      expect(aliceTasks.commitments).toHaveLength(2);

      // --- unowned filter ---
      const unownedTasks = await listCommitments({
        userId,
        unowned: true,
        provenance: "trusted",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      const unownedIds = unownedTasks.commitments.map((c) => c.taskId);
      expect(unownedIds).toContain(taskUnownedId);
      expect(unownedIds).not.toContain(taskPendingId);
      expect(unownedIds).not.toContain(taskInProgressId);

      // --- dueBefore / dueAfter ---
      const beforeMarch = await listCommitments({
        userId,
        dueBefore: "2026-03-01",
        provenance: "trusted",
        sort: "dueOn",
        order: "asc",
        limit: 50,
      });
      expect(beforeMarch.commitments.map((c) => c.taskId)).toContain(
        taskPendingId,
      );
      expect(beforeMarch.commitments.map((c) => c.taskId)).not.toContain(
        taskInProgressId,
      );

      const afterMarch = await listCommitments({
        userId,
        dueAfter: "2026-03-01",
        provenance: "trusted",
        sort: "dueOn",
        order: "asc",
        limit: 50,
      });
      expect(afterMarch.commitments.map((c) => c.taskId)).toContain(
        taskInProgressId,
      );
      expect(afterMarch.commitments.map((c) => c.taskId)).not.toContain(
        taskPendingId,
      );

      // --- hasDueDate true/false ---
      const withDue = await listCommitments({
        userId,
        hasDueDate: true,
        provenance: "trusted",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(withDue.commitments.map((c) => c.taskId)).toContain(taskPendingId);
      expect(withDue.commitments.map((c) => c.taskId)).toContain(
        taskInProgressId,
      );
      expect(withDue.commitments.every((c) => c.dueOn !== null)).toBe(true);

      const withoutDue = await listCommitments({
        userId,
        hasDueDate: false,
        provenance: "trusted",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(withoutDue.commitments.every((c) => c.dueOn === null)).toBe(true);
      expect(withoutDue.commitments.map((c) => c.taskId)).not.toContain(
        taskPendingId,
      );

      // --- Search (label substring, case-insensitive) ---
      const searchAlpha = await listCommitments({
        userId,
        search: "alpha",
        provenance: "all",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      expect(searchAlpha.commitments.map((c) => c.taskId)).toEqual([
        taskPendingId,
      ]);

      const searchTask = await listCommitments({
        userId,
        search: "TASK",
        provenance: "all",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      // All 6 tasks have "task" in their label
      expect(searchTask.commitments).toHaveLength(6);

      // --- Sort: statusChangedAt desc ---
      const sortByStatus = await listCommitments({
        userId,
        provenance: "all",
        sort: "statusChangedAt",
        order: "desc",
        limit: 50,
      });
      const statusDates = sortByStatus.commitments.map((c) =>
        c.statusChangedAt.getTime(),
      );
      expect(statusDates).toEqual([...statusDates].sort((a, b) => b - a));

      // --- Sort: createdAt asc ---
      const sortByCreated = await listCommitments({
        userId,
        provenance: "all",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      const createdDates = sortByCreated.commitments.map((c) =>
        c.createdAt.getTime(),
      );
      expect(createdDates).toEqual([...createdDates].sort((a, b) => a - b));

      // --- Sort: label asc ---
      const sortByLabel = await listCommitments({
        userId,
        provenance: "all",
        sort: "label",
        order: "asc",
        limit: 50,
      });
      const labels = sortByLabel.commitments.map((c) => c.label ?? "");
      expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));

      // --- Sort: dueOn asc — undated tasks last ---
      const sortByDue = await listCommitments({
        userId,
        provenance: "all",
        sort: "dueOn",
        order: "asc",
        limit: 50,
      });
      const dues = sortByDue.commitments.map((c) => c.dueOn);
      // All non-null dueOns must come before nulls
      const firstNull = dues.findIndex((d) => d === null);
      const lastNonNull = dues.reduce(
        (acc, d, i) => (d !== null ? i : acc),
        -1,
      );
      expect(firstNull === -1 || lastNonNull < firstNull).toBe(true);
      // The two dated tasks should be first in ascending date order
      const datedDues = dues.filter((d): d is string => d !== null);
      expect(datedDues).toEqual([...datedDues].sort());

      // --- Keyset pagination roundtrip ---
      const unpaginated = await listCommitments({
        userId,
        provenance: "all",
        sort: "createdAt",
        order: "asc",
        limit: 50,
      });
      const totalCount = unpaginated.commitments.length;
      expect(totalCount).toBeGreaterThan(0);

      // Page with limit=2 and follow nextCursor until exhausted
      const collected: string[] = [];
      let nextCursor: string | null = null;
      do {
        const page = await listCommitments({
          userId,
          provenance: "all",
          sort: "createdAt",
          order: "asc",
          limit: 2,
          cursor: nextCursor ?? undefined,
        });
        for (const c of page.commitments) {
          collected.push(c.taskId);
        }
        nextCursor = page.nextCursor;
      } while (nextCursor !== null);

      // No duplicates
      expect(new Set(collected).size).toBe(collected.length);
      // Covers the same rows as unpaginated
      expect(collected).toEqual(unpaginated.commitments.map((c) => c.taskId));

      // --- dueOn sort pagination: undated rows last, no gaps ---
      const unpaginatedDue = await listCommitments({
        userId,
        provenance: "all",
        sort: "dueOn",
        order: "asc",
        limit: 50,
      });
      const collectedDue: string[] = [];
      let nextDueCursor: string | null = null;
      do {
        const page = await listCommitments({
          userId,
          provenance: "all",
          sort: "dueOn",
          order: "asc",
          limit: 2,
          cursor: nextDueCursor ?? undefined,
        });
        for (const c of page.commitments) {
          collectedDue.push(c.taskId);
        }
        nextDueCursor = page.nextCursor;
      } while (nextDueCursor !== null);

      expect(collectedDue).toEqual(
        unpaginatedDue.commitments.map((c) => c.taskId),
      );
      // Undated tasks (no dueOn) must trail dated ones
      const undatedIds = unpaginatedDue.commitments
        .filter((c) => c.dueOn === null)
        .map((c) => c.taskId);
      const datedIds = unpaginatedDue.commitments
        .filter((c) => c.dueOn !== null)
        .map((c) => c.taskId);
      for (const uid of undatedIds) {
        for (const did of datedIds) {
          expect(collectedDue.indexOf(uid)).toBeGreaterThan(
            collectedDue.indexOf(did),
          );
        }
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
