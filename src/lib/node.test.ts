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

describeIfServer("node operations", () => {
  const dbName = `memory_node_test_${Date.now()}_${Math.floor(
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

  it("returns aliases with active claims and preserves descriptions on updates", async () => {
    const userId = "user_A";
    const aliceNodeId = newTypeId("node");
    const laptopNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const aliasId = newTypeId("alias");
    const sourceLinkId = newTypeId("source_link");
    const activeClaimId = newTypeId("claim");
    const retractedClaimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
        usage: { total_tokens: 0 },
      }),
    }));
    vi.doMock("~/lib/sources", () => ({
      sourceService: { fetchRaw: async () => [] },
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
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "sources_user_type_external_unique"
            UNIQUE ("user_id", "type", "external_id")
        );
        CREATE TABLE "source_links" (
          "id" text PRIMARY KEY NOT NULL,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "specific_location" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
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
        CREATE TABLE "aliases" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "alias_text" text NOT NULL,
          "normalized_alias_text" text NOT NULL,
          "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "aliases_user_normalized_canonical_unique"
            UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, $3, 'Person'),
              ($2, $3, 'Object')
        `,
        [aliceNodeId, laptopNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $3, 'Alice', 'alice', 'Generated profile'),
              ($2, $4, 'MacBook Pro', 'macbook pro', 'Laptop profile')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          aliceNodeId,
          laptopNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES ($1, $2, 'manual', 'manual:user_A', 'completed')
        `,
        [sourceId, userId],
      );
      await client.query(
        `
          INSERT INTO "source_links" ("id", "source_id", "node_id")
            VALUES ($1, $2, $3)
        `,
        [sourceLinkId, sourceId, aliceNodeId],
      );
      await client.query(
        `
          INSERT INTO "aliases" (
            "id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id"
          )
          VALUES ($1, $2, 'Ally', 'ally', $3)
        `,
        [aliasId, userId, aliceNodeId],
      );
      await client.query(
        `
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id",
            "predicate", "statement", "source_id", "asserted_by_kind", "stated_at", "status"
          )
          VALUES
            ($1, $6, $3, $4, 'OWNED_BY', 'Alice owns a MacBook Pro.', $5, 'user', now(), 'active'),
            ($2, $6, $3, $4, 'TAGGED_WITH', 'Alice was tagged with a MacBook Pro.', $5, 'user', now(), 'retracted')
        `,
        [
          activeClaimId,
          retractedClaimId,
          aliceNodeId,
          laptopNodeId,
          sourceId,
          userId,
        ],
      );

      const { getNodeById, updateNode } = await import("./node");

      const nodeResult = await getNodeById(userId, aliceNodeId);
      expect(nodeResult?.node).toMatchObject({
        id: aliceNodeId,
        label: "Alice",
        description: "Generated profile",
        sourceIds: [sourceId],
        aliases: [{ id: aliasId, aliasText: "Ally" }],
      });
      expect(nodeResult?.claims).toHaveLength(1);
      expect(nodeResult?.claims[0]).toMatchObject({
        id: activeClaimId,
        predicate: "OWNED_BY",
        statement: "Alice owns a MacBook Pro.",
      });

      const updated = await updateNode(userId, aliceNodeId, {
        nodeType: "Concept",
      });
      expect(updated).toMatchObject({
        id: aliceNodeId,
        nodeType: "Concept",
        description: "Generated profile",
      });

      const persistedDescription = await client.query<{
        description: string | null;
      }>(`SELECT "description" FROM "node_metadata" WHERE "node_id" = $1`, [
        aliceNodeId,
      ]);
      expect(persistedDescription.rows[0]?.description).toBe(
        "Generated profile",
      );
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/embeddings");
      vi.doUnmock("~/lib/sources");
      vi.resetModules();
      await client.end();
    }
  });

  async function ensureMergeTables(client: Client): Promise<void> {
    // The first test in this file creates the core tables inline. Merge-path
    // tests additionally need `node_embeddings`. Idempotent so subsequent
    // tests can call this without conflicting with the inline creation above.
    await client.query(`
      CREATE TABLE IF NOT EXISTS "node_embeddings" (
        "id" text PRIMARY KEY NOT NULL,
        "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
        "embedding" jsonb,
        "model_name" varchar(100),
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
  }

  it("rewires assertedByNodeId on merge so participant provenance survives", async () => {
    // PR 4iii Issue 2: when a placeholder Person is merged into a real Person,
    // the consumed node is deleted and the FK on `claims.asserted_by_node_id`
    // is `ON DELETE SET NULL`. Without an explicit rewire participant claims
    // would silently lose attribution. We assert the survivor inherits it.
    const userId = "user_merge_provenance";
    const placeholderId = newTypeId("node");
    const realPersonId = newTypeId("node");
    const subjectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
        usage: { total_tokens: 0 },
      }),
    }));

    try {
      await ensureMergeTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
           ($1, $4, 'Person'),
           ($2, $4, 'Person'),
           ($3, $4, 'Concept')`,
        [realPersonId, placeholderId, subjectNodeId, userId],
      );
      // Real Person row keeps a clean additionalData; the placeholder carries
      // `unresolvedSpeaker: true` so we can also exercise Issue 5 (the flag is
      // cleared when a resolved Person is folded into a placeholder survivor —
      // but here the survivor is the real Person, so the flag should simply be
      // gone after the merge regardless).
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
           ($1, $4, 'Real Alex', 'real alex'),
           ($2, $5, 'Alex', 'alex'),
           ($3, $6, 'Project Atlas', 'project atlas')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          realPersonId,
          placeholderId,
          subjectNodeId,
        ],
      );
      // Tag the placeholder explicitly to validate Issue 5's clearing branch
      // is not triggered here (survivor is the real Person, no flag to clear).
      await client.query(
        `UPDATE "node_metadata" SET "additional_data" = '{"unresolvedSpeaker": true}'::jsonb
         WHERE "node_id" = $1`,
        [placeholderId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
         VALUES ($1, $2, 'meeting_transcript', 'meeting:user_merge_provenance', 'completed')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate", "statement",
           "source_id", "scope", "asserted_by_kind", "asserted_by_node_id", "stated_at"
         ) VALUES ($1, $2, $3, 'tighter spec', 'HAS_PREFERENCE',
                   'Alex prefers a tighter spec.', $4, 'personal', 'participant', $5, now())`,
        [claimId, userId, subjectNodeId, sourceId, placeholderId],
      );

      const { mergeNodes } = await import("./node");
      const merged = await mergeNodes(userId, [realPersonId, placeholderId]);
      expect(merged?.id).toBe(realPersonId);

      // Placeholder is gone, claim survives, attribution rewired.
      const remainingPersons = await client.query<{ id: string }>(
        `SELECT "id" FROM "nodes" WHERE "user_id" = $1 AND "node_type" = 'Person'`,
        [userId],
      );
      expect(remainingPersons.rows.map((r) => r.id)).toEqual([realPersonId]);

      const claimRows = await client.query<{
        id: string;
        asserted_by_kind: string;
        asserted_by_node_id: string | null;
      }>(
        `SELECT "id", "asserted_by_kind", "asserted_by_node_id" FROM "claims" WHERE "id" = $1`,
        [claimId],
      );
      expect(claimRows.rows).toHaveLength(1);
      expect(claimRows.rows[0]).toMatchObject({
        asserted_by_kind: "participant",
        asserted_by_node_id: realPersonId,
      });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/embeddings");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws CrossScopeMergeError when candidates span personal and reference scopes", async () => {
    // Mirrors the dedup-sweep cross-scope guard: an explicit `mergeNodes` call
    // over a personal + reference pair must refuse, so the route can translate
    // it into a 409 Conflict instead of a 500.
    const userId = "user_merge_cross_scope";
    const personalId = newTypeId("node");
    const referenceId = newTypeId("node");
    const personalSourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
        usage: { total_tokens: 0 },
      }),
    }));

    try {
      await ensureMergeTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
           ($1, $3, 'Person'),
           ($2, $3, 'Person')`,
        [personalId, referenceId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
           ($1, $3, 'Marie Curie', 'marie curie'),
           ($2, $4, 'Marie Curie', 'marie curie')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personalId,
          referenceId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES
           ($1, $3, 'manual', 'manual:user_merge_cross_scope:personal', 'personal', 'completed'),
           ($2, $3, 'document', 'doc:user_merge_cross_scope:reference', 'reference', 'completed')`,
        [personalSourceId, referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate", "statement",
           "source_id", "scope", "asserted_by_kind", "stated_at"
         ) VALUES
           ($1, $5, $2, 'admires', 'HAS_PREFERENCE', 'User admires Marie Curie.', $3, 'personal', 'user', now()),
           ($4, $5, $6, 'physicist', 'HAS_GOAL', 'Marie Curie was a physicist.', $7, 'reference', 'document_author', now())`,
        [
          newTypeId("claim"),
          personalId,
          personalSourceId,
          newTypeId("claim"),
          userId,
          referenceId,
          referenceSourceId,
        ],
      );

      const { mergeNodes, CrossScopeMergeError } = await import("./node");
      await expect(
        mergeNodes(userId, [personalId, referenceId]),
      ).rejects.toBeInstanceOf(CrossScopeMergeError);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/embeddings");
      vi.resetModules();
      await client.end();
    }
  });

  it("cascades dependent claims and clears participant provenance on deleteNode", async () => {
    // Regression for the "phantom target" report: deleting a node must take
    // every claim with the node as subject or object (`ON DELETE CASCADE`),
    // and must NULL `asserted_by_node_id` for participant claims while leaving
    // those claims active (`ON DELETE SET NULL`). The reported counts let
    // callers audit the blast radius after a destructive op.
    const userId = "user_delete_cascade";
    const targetNodeId = newTypeId("node");
    const subjectNodeId = newTypeId("node");
    const otherNodeId = newTypeId("node");
    const objectClaimId = newTypeId("claim");
    const subjectClaimId = newTypeId("claim");
    const participantClaimId = newTypeId("claim");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
        usage: { total_tokens: 0 },
      }),
    }));

    try {
      await ensureMergeTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
           ($1, $4, 'Person'),
           ($2, $4, 'Task'),
           ($3, $4, 'Person')`,
        [targetNodeId, subjectNodeId, otherNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
           ($1, $4, 'Midday Marcel', 'midday marcel'),
           ($2, $5, 'Ship the report', 'ship the report'),
           ($3, $6, 'Other Person', 'other person')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          targetNodeId,
          subjectNodeId,
          otherNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
         VALUES ($1, $2, 'manual', 'manual:user_delete_cascade', 'completed')`,
        [sourceId, userId],
      );
      // Three claims:
      //  1. target as OBJECT (OWNED_BY) — must cascade-delete.
      //  2. target as SUBJECT (HAS_PREFERENCE attribute) — must cascade-delete.
      //  3. target as ASSERTED_BY (participant) on a claim about a DIFFERENT
      //     subject/object — must SURVIVE with asserted_by_node_id NULL.
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_node_id", "object_value",
           "predicate", "statement", "source_id", "scope", "asserted_by_kind",
           "asserted_by_node_id", "stated_at", "status"
         ) VALUES
           ($1, $9, $4, $5, NULL, 'OWNED_BY', 'Task owned by Midday Marcel.',
            $8, 'personal', 'user', NULL, now(), 'active'),
           ($2, $9, $5, NULL, 'tighter spec', 'HAS_PREFERENCE',
            'Midday Marcel prefers a tighter spec.', $8, 'personal', 'user',
            NULL, now(), 'active'),
           ($3, $9, $6, NULL, 'tea', 'HAS_PREFERENCE',
            'Other Person prefers tea (per Midday Marcel).', $8, 'personal',
            'participant', $7, now(), 'active')`,
        [
          objectClaimId,
          subjectClaimId,
          participantClaimId,
          subjectNodeId,
          targetNodeId,
          otherNodeId,
          targetNodeId, // asserted_by for claim 3
          sourceId,
          userId,
        ],
      );

      const { deleteNode } = await import("./node");
      const result = await deleteNode(userId, targetNodeId);
      expect(result.deleted).toBe(true);
      expect(result.affectedClaims.cascadeDeleted).toBe(2);
      expect(result.affectedClaims.assertedByCleared).toBe(1);

      // Target node is gone.
      const remainingNodes = await client.query<{ id: string }>(
        `SELECT "id" FROM "nodes" WHERE "id" = $1`,
        [targetNodeId],
      );
      expect(remainingNodes.rows).toHaveLength(0);

      // Cascade-deleted claims are gone — no phantom rows pointing at the
      // erased node (the bug reported).
      const cascadeRows = await client.query<{ id: string }>(
        `SELECT "id" FROM "claims" WHERE "id" = ANY($1)`,
        [[objectClaimId, subjectClaimId]],
      );
      expect(cascadeRows.rows).toHaveLength(0);

      // Participant claim survives, attribution nulled, still active.
      const participantRows = await client.query<{
        id: string;
        status: string;
        asserted_by_node_id: string | null;
      }>(
        `SELECT "id", "status", "asserted_by_node_id" FROM "claims" WHERE "id" = $1`,
        [participantClaimId],
      );
      expect(participantRows.rows).toHaveLength(1);
      expect(participantRows.rows[0]).toMatchObject({
        status: "active",
        asserted_by_node_id: null,
      });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/embeddings");
      vi.resetModules();
      await client.end();
    }
  });

  it("clears unresolvedSpeaker on the survivor when a resolved Person is merged into a placeholder", async () => {
    // PR 4iii Issue 5: if the survivor is the placeholder (e.g., older
    // createdAt) and the consumed node is a resolved Person, the survivor's
    // `unresolvedSpeaker` flag must be stripped — otherwise the merged
    // identity continues to look unresolved forever.
    const userId = "user_merge_unresolved";
    const placeholderId = newTypeId("node");
    const resolvedId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
        usage: { total_tokens: 0 },
      }),
    }));

    try {
      await ensureMergeTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
           ($1, $3, 'Person'),
           ($2, $3, 'Person')`,
        [placeholderId, resolvedId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "additional_data") VALUES
           ($1, $3, 'Alex', 'alex', '{"unresolvedSpeaker": true, "preserveMe": "yes"}'::jsonb),
           ($2, $4, 'Alex', 'alex', NULL)`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          placeholderId,
          resolvedId,
        ],
      );

      const { mergeNodes } = await import("./node");
      // Survivor is placeholderId (first in the list) — older / placeholder.
      const merged = await mergeNodes(userId, [placeholderId, resolvedId]);
      expect(merged?.id).toBe(placeholderId);

      const survivorRow = await client.query<{
        additional_data: Record<string, unknown> | null;
      }>(
        `SELECT "additional_data" FROM "node_metadata" WHERE "node_id" = $1`,
        [placeholderId],
      );
      const additional = survivorRow.rows[0]?.additional_data;
      expect(additional).not.toBeNull();
      // Flag is gone, but other keys are preserved.
      expect(additional?.["unresolvedSpeaker"]).toBeUndefined();
      expect(additional?.["preserveMe"]).toBe("yes");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/embeddings");
      vi.resetModules();
      await client.end();
    }
  });

  it("attaches a manually-created node to today's day node via OCCURRED_ON", async () => {
    // Regression for the linkage gap: `/node/create` previously did not link
    // the new node to a Temporal day node, so `/query/node-type` (which
    // traverses one hop from the day node) returned empty for nodes created
    // through the manual API.
    const userId = "user_create_node_day_link";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{ embedding: Array.from({ length: 1024 }, () => 0) }],
        usage: { total_tokens: 0 },
      }),
    }));

    try {
      await ensureMergeTables(client);
      // The inline `sources` table created by the first test in this file is
      // missing optional columns referenced by Drizzle's insert. Add them so
      // `ensureSystemSource` (used by `createNode` for the manual source)
      // succeeds without falling back to full migrations.
      await client.query(`
        ALTER TABLE "sources"
          ADD COLUMN IF NOT EXISTS "parent_source" text,
          ADD COLUMN IF NOT EXISTS "metadata" jsonb,
          ADD COLUMN IF NOT EXISTS "last_ingested_at" timestamp with time zone,
          ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
          ADD COLUMN IF NOT EXISTS "content_type" varchar(100),
          ADD COLUMN IF NOT EXISTS "content_length" integer;
      `);

      const { createNode } = await import("./node");
      const created = await createNode(
        userId,
        "Person",
        "Lila Test Person",
        "A person created via /node/create",
      );

      // OCCURRED_ON claim links the new node to a Temporal day node.
      const claimRows = await client.query<{
        subject_node_id: string;
        object_node_id: string | null;
        predicate: string;
        asserted_by_kind: string;
      }>(
        `SELECT "subject_node_id", "object_node_id", "predicate", "asserted_by_kind"
         FROM "claims"
         WHERE "user_id" = $1 AND "subject_node_id" = $2 AND "predicate" = 'OCCURRED_ON'`,
        [userId, created.id],
      );
      expect(claimRows.rows).toHaveLength(1);
      const dayLinkClaim = claimRows.rows[0]!;
      expect(dayLinkClaim.subject_node_id).toBe(created.id);
      expect(dayLinkClaim.asserted_by_kind).toBe("system");
      expect(dayLinkClaim.object_node_id).not.toBeNull();

      // The object node is a Temporal day node labelled YYYY-MM-DD.
      const dayNodeRows = await client.query<{
        node_type: string;
        label: string;
      }>(
        `SELECT n."node_type", m."label"
         FROM "nodes" n
         INNER JOIN "node_metadata" m ON m."node_id" = n."id"
         WHERE n."id" = $1`,
        [dayLinkClaim.object_node_id],
      );
      expect(dayNodeRows.rows).toHaveLength(1);
      expect(dayNodeRows.rows[0]?.node_type).toBe("Temporal");
      expect(dayNodeRows.rows[0]?.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // The claim is sourced from the per-user manual system source.
      const sourceRows = await client.query<{ type: string }>(
        `SELECT s."type"
         FROM "claims" c
         INNER JOIN "sources" s ON s."id" = c."source_id"
         WHERE c."subject_node_id" = $1 AND c."predicate" = 'OCCURRED_ON'`,
        [created.id],
      );
      expect(sourceRows.rows[0]?.type).toBe("manual");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("~/lib/embeddings");
      vi.resetModules();
      await client.end();
    }
  });
});
