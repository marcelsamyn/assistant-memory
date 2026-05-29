import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { queryRecentChangesResponseSchema } from "~/lib/schemas/query-recent-changes";
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

describeIfServer("recent changes query", () => {
  const dbName = `memory_recent_changes_test_${Date.now()}_${Math.floor(
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

  it("returns active personal claims and nodes added/updated in the window with labels and provenance", async () => {
    const userId = "user_recent_changes";

    // Window under test: [SINCE, UNTIL].
    const SINCE = "2026-05-20T00:00:00.000Z";
    const UNTIL = "2026-05-29T00:00:00.000Z";

    const personLena = newTypeId("node"); // added in window
    const projectBook = newTypeId("node"); // old node, linked in window -> updated
    const goalNode = newTypeId("node"); // old node, claim updated in window -> updated
    const dayNode = newTypeId("node"); // Temporal, added in window -> excluded (structural)
    const oldPerson = newTypeId("node"); // old node, only stale claims -> excluded
    const refNode = newTypeId("node"); // old node, only a reference claim -> excluded

    const srcConv = newTypeId("source");
    const srcRef = newTypeId("source");

    const claimAdded = newTypeId("claim");
    const claimUpdated = newTypeId("claim");
    const claimSuperseded = newTypeId("claim");
    const claimReference = newTypeId("claim");
    const claimOld = newTypeId("claim");

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
          "parent_source" text,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "metadata" jsonb,
          "last_ingested_at" timestamp with time zone,
          "status" varchar(20) DEFAULT 'pending',
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "deleted_at" timestamp with time zone,
          "content_type" varchar(100),
          "content_length" integer
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
          "metadata" jsonb,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "asserted_by_kind" varchar(24) NOT NULL,
          "asserted_by_node_id" text REFERENCES "nodes"("id") ON DELETE SET NULL,
          "superseded_by_claim_id" text,
          "contradicted_by_claim_id" text,
          "stated_at" timestamp with time zone NOT NULL,
          "valid_from" timestamp with time zone,
          "valid_to" timestamp with time zone,
          "status" varchar(30) DEFAULT 'active' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await database.insert(schema.users).values({ id: userId });

      await database.insert(schema.sources).values([
        {
          id: srcConv,
          userId,
          type: "conversation",
          externalId: "conv:1",
          scope: "personal",
          metadata: { title: "Coaching call" },
          lastIngestedAt: new Date("2026-05-28T09:00:00.000Z"),
          status: "completed",
          createdAt: new Date("2026-05-28T08:00:00.000Z"),
        },
        {
          id: srcRef,
          userId,
          type: "document",
          externalId: "doc:1",
          scope: "reference",
          metadata: { title: "Reference doc" },
          lastIngestedAt: new Date("2026-05-24T00:00:00.000Z"),
          status: "completed",
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
        },
      ]);

      await database.insert(schema.nodes).values([
        {
          id: personLena,
          userId,
          nodeType: "Person",
          createdAt: new Date("2026-05-28T10:00:00.000Z"),
        },
        {
          id: projectBook,
          userId,
          nodeType: "Object",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          id: goalNode,
          userId,
          nodeType: "Concept",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          id: dayNode,
          userId,
          nodeType: "Temporal",
          createdAt: new Date("2026-05-28T00:00:00.000Z"),
        },
        {
          id: oldPerson,
          userId,
          nodeType: "Person",
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
        {
          id: refNode,
          userId,
          nodeType: "Concept",
          createdAt: new Date("2026-01-04T00:00:00.000Z"),
        },
      ]);

      await database.insert(schema.nodeMetadata).values([
        { id: newTypeId("node_metadata"), nodeId: personLena, label: "Lena" },
        { id: newTypeId("node_metadata"), nodeId: projectBook, label: "Book" },
        {
          id: newTypeId("node_metadata"),
          nodeId: goalNode,
          label: "Draft goal",
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: dayNode,
          label: "2026-05-28",
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: oldPerson,
          label: "Old Person",
        },
        { id: newTypeId("node_metadata"), nodeId: refNode, label: "Ref node" },
      ]);

      await database.insert(schema.claims).values([
        {
          // Added in window; links existing project node.
          id: claimAdded,
          userId,
          subjectNodeId: personLena,
          objectNodeId: projectBook,
          predicate: "RELATED_TO",
          statement: "Lena is linked to the Book project.",
          sourceId: srcConv,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-05-28T10:01:00.000Z"),
          status: "active",
          createdAt: new Date("2026-05-28T10:01:00.000Z"),
          updatedAt: new Date("2026-05-28T10:01:00.000Z"),
        },
        {
          // Created before the window, updated inside it (value claim).
          id: claimUpdated,
          userId,
          subjectNodeId: goalNode,
          objectValue: "finish draft by June 30",
          predicate: "HAS_GOAL",
          statement: "Goal: finish draft by June 30.",
          sourceId: srcConv,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-01-05T00:00:00.000Z"),
          status: "active",
          createdAt: new Date("2026-01-05T00:00:00.000Z"),
          updatedAt: new Date("2026-05-27T10:00:00.000Z"),
        },
        {
          // In window but superseded -> excluded; must not "update" oldPerson.
          id: claimSuperseded,
          userId,
          subjectNodeId: oldPerson,
          objectNodeId: projectBook,
          predicate: "RELATED_TO",
          statement: "Old Person was linked to the Book project.",
          sourceId: srcConv,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-05-26T00:00:00.000Z"),
          status: "superseded",
          createdAt: new Date("2026-05-26T00:00:00.000Z"),
          updatedAt: new Date("2026-05-26T00:00:00.000Z"),
        },
        {
          // In window but reference scope -> excluded; must not "update" refNode.
          id: claimReference,
          userId,
          subjectNodeId: refNode,
          objectValue: "reference value",
          predicate: "RELATED_TO",
          statement: "Reference material note.",
          sourceId: srcRef,
          scope: "reference",
          assertedByKind: "document_author",
          statedAt: new Date("2026-05-24T00:00:00.000Z"),
          status: "active",
          createdAt: new Date("2026-05-24T00:00:00.000Z"),
          updatedAt: new Date("2026-05-24T00:00:00.000Z"),
        },
        {
          // Entirely before the window -> excluded.
          id: claimOld,
          userId,
          subjectNodeId: oldPerson,
          objectValue: "old value",
          predicate: "RELATED_TO",
          statement: "Old Person had an old note.",
          sourceId: srcConv,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-01-10T00:00:00.000Z"),
          status: "active",
          createdAt: new Date("2026-01-10T00:00:00.000Z"),
          updatedAt: new Date("2026-01-10T00:00:00.000Z"),
        },
      ]);

      const { queryRecentChanges } = await import("./recent-changes");

      // --- Default call over the window -----------------------------------
      const parsed = queryRecentChangesResponseSchema.parse(
        await queryRecentChanges({
          userId,
          since: SINCE,
          until: UNTIL,
          limit: 100,
        }),
      );

      // Claims: only the active personal ones changed in the window, newest
      // change first (added before the older updated claim).
      expect(parsed.claims.map((c) => c.id)).toEqual([
        claimAdded,
        claimUpdated,
      ]);
      expect(parsed.claims[0]).toMatchObject({
        id: claimAdded,
        changeKind: "added",
        predicate: "RELATED_TO",
        subjectLabel: "Lena",
        objectLabel: "Book",
        sourceId: srcConv,
        assertedByKind: "user",
      });
      expect(parsed.claims[1]).toMatchObject({
        id: claimUpdated,
        changeKind: "updated",
        predicate: "HAS_GOAL",
        // Attribute claims surface the literal objectValue as objectLabel.
        objectLabel: "finish draft by June 30",
      });

      // Nodes: added (personLena) plus existing nodes touched in the window
      // (projectBook, goalNode), newest change first. Structural day node and
      // untouched/stale/reference-only nodes are excluded.
      expect(
        parsed.nodes.map((n) => ({ id: n.id, changeKind: n.changeKind })),
      ).toEqual([
        { id: projectBook, changeKind: "updated" },
        { id: personLena, changeKind: "added" },
        { id: goalNode, changeKind: "updated" },
      ]);
      const nodeIds = parsed.nodes.map((n) => n.id);
      expect(nodeIds).not.toContain(dayNode);
      expect(nodeIds).not.toContain(oldPerson);
      expect(nodeIds).not.toContain(refNode);

      // Labels are carried on the node rows — no N+1 getNode required.
      expect(parsed.nodes.find((n) => n.id === personLena)?.label).toBe("Lena");

      // Sources: distinct provenance behind the returned claims only.
      expect(parsed.sources).toEqual([
        expect.objectContaining({
          sourceId: srcConv,
          type: "conversation",
          title: "Coaching call",
        }),
      ]);
      expect(parsed.sources[0]?.timestamp.toISOString()).toBe(
        "2026-05-28T09:00:00.000Z",
      );

      // --- nodeTypes filter narrows claims and nodes ----------------------
      const filtered = queryRecentChangesResponseSchema.parse(
        await queryRecentChanges({
          userId,
          since: SINCE,
          until: UNTIL,
          limit: 100,
          nodeTypes: ["Person"],
        }),
      );
      // Only the claim whose subject/object is a Person survives.
      expect(filtered.claims.map((c) => c.id)).toEqual([claimAdded]);
      // Only the Person node added in the window survives.
      expect(filtered.nodes.map((n) => n.id)).toEqual([personLena]);
      expect(filtered.nodes[0]).toMatchObject({
        changeKind: "added",
        nodeType: "Person",
      });

      // --- since > until is an empty range --------------------------------
      await expect(
        queryRecentChanges({
          userId,
          since: UNTIL,
          until: SINCE,
          limit: 100,
        }),
      ).resolves.toEqual({ claims: [], nodes: [], sources: [] });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
