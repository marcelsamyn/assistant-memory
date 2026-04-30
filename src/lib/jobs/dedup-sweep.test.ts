import "dotenv/config";
import { runDedupSweep } from "./dedup-sweep";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describeIfServer("runDedupSweep", () => {
  const dbName = `memory_dedup_sweep_test_${Date.now()}_${Math.floor(
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

  async function createDedupTables(client: Client): Promise<void> {
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
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
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
    `);
  }

  async function seedNode(
    client: Client,
    {
      userId,
      nodeId,
      nodeType,
      canonicalLabel,
      label,
    }: {
      userId: string;
      nodeId: string;
      nodeType: string;
      canonicalLabel: string;
      label?: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, $3)`,
      [nodeId, userId, nodeType],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
       VALUES ($1, $2, $3, $4)`,
      [newTypeId("node_metadata"), nodeId, label ?? canonicalLabel, canonicalLabel],
    );
  }

  it("merges duplicates within the same scope", async () => {
    const userId = "user_dedup_A";
    const keepId = newTypeId("node");
    const removeId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createDedupTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'manual', 'manual:user_dedup_A', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await seedNode(client, {
        userId,
        nodeId: keepId,
        nodeType: "Person",
        canonicalLabel: "alice",
      });
      await seedNode(client, {
        userId,
        nodeId: removeId,
        nodeType: "Person",
        canonicalLabel: "alice",
      });

      // Personal claim on the keeper, anchoring scope.
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate", "statement",
           "source_id", "scope", "asserted_by_kind", "stated_at"
         ) VALUES ($1, $2, $3, 'tea', 'HAS_PREFERENCE', 'Likes tea.', $4, 'personal', 'user', now())`,
        [newTypeId("claim"), userId, keepId, sourceId],
      );

      const result = await runDedupSweep(userId, database);

      expect(result.mergedGroups).toBe(1);
      expect(result.mergedNodes).toBe(1);
      expect(result.crossScopeCollisionsSkipped).toBe(0);

      const remaining = await client.query<{ id: string }>(
        `SELECT "id" FROM "nodes" WHERE "user_id" = $1`,
        [userId],
      );
      expect(remaining.rows.map((r) => r.id).sort()).toEqual([keepId].sort());
    } finally {
      await client.end();
    }
  });

  it("does not merge nodes with same label across scopes", async () => {
    const userId = "user_dedup_B";
    const personalId = newTypeId("node");
    const referenceId = newTypeId("node");
    const personalSourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createDedupTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES
           ($1, $3, 'manual', 'manual:user_dedup_B:personal', 'personal', 'completed'),
           ($2, $3, 'document', 'doc:user_dedup_B:reference', 'reference', 'completed')`,
        [personalSourceId, referenceSourceId, userId],
      );

      await seedNode(client, {
        userId,
        nodeId: personalId,
        nodeType: "Person",
        canonicalLabel: "marie curie",
      });
      await seedNode(client, {
        userId,
        nodeId: referenceId,
        nodeType: "Person",
        canonicalLabel: "marie curie",
      });

      // Personal-scope claim on the personal node, reference-scope claim on the reference node.
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

      const result = await runDedupSweep(userId, database);

      expect(result.mergedGroups).toBe(0);
      expect(result.mergedNodes).toBe(0);
      expect(result.crossScopeCollisionsSkipped).toBe(1);

      const remaining = await client.query<{ id: string }>(
        `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
        [userId],
      );
      expect(remaining.rows.map((r) => r.id).sort()).toEqual(
        [personalId, referenceId].sort(),
      );
    } finally {
      await client.end();
    }
  });

  it("keeps claims that differ only in assertedByKind", async () => {
    const userId = "user_dedup_C";
    const keepId = newTypeId("node");
    const removeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const userClaimId = newTypeId("claim");
    const systemClaimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createDedupTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'manual', 'manual:user_dedup_C', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await seedNode(client, {
        userId,
        nodeId: keepId,
        nodeType: "Person",
        canonicalLabel: "bob",
      });
      await seedNode(client, {
        userId,
        nodeId: removeId,
        nodeType: "Person",
        canonicalLabel: "bob",
      });

      // Each node carries one HAS_PREFERENCE='coffee' claim with the same
      // (subject-after-rewire, predicate, source, objectValue) but different
      // assertedByKind. Both must survive.
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate", "statement",
           "source_id", "scope", "asserted_by_kind", "stated_at"
         ) VALUES
           ($1, $5, $2, 'coffee', 'HAS_PREFERENCE', 'Bob likes coffee (user).', $4, 'personal', 'user', now()),
           ($3, $5, $6, 'coffee', 'HAS_PREFERENCE', 'Bob likes coffee (system).', $4, 'personal', 'system', now())`,
        [userClaimId, keepId, systemClaimId, sourceId, userId, removeId],
      );

      const result = await runDedupSweep(userId, database);
      expect(result.mergedGroups).toBe(1);
      expect(result.mergedNodes).toBe(1);

      const claims = await client.query<{
        id: string;
        subject_node_id: string;
        asserted_by_kind: string;
      }>(
        `SELECT "id", "subject_node_id", "asserted_by_kind"
         FROM "claims"
         WHERE "user_id" = $1
         ORDER BY "asserted_by_kind"`,
        [userId],
      );

      expect(claims.rows).toHaveLength(2);
      expect(claims.rows.map((r) => r.asserted_by_kind).sort()).toEqual([
        "system",
        "user",
      ]);
      // Both rewired onto the surviving keeper.
      for (const row of claims.rows) {
        expect(row.subject_node_id).toBe(keepId);
      }
    } finally {
      await client.end();
    }
  });

  it("does not merge unresolved-speaker placeholder Persons even when labels collide", async () => {
    // Two placeholder Persons sharing the label "Alex" come from different
    // transcripts and almost certainly refer to different real people. Merging
    // them by label alone would destroy distinct identities.
    const userId = "user_dedup_placeholder";
    const placeholderA = newTypeId("node");
    const placeholderB = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createDedupTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      for (const id of [placeholderA, placeholderB]) {
        await client.query(
          `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
          [id, userId],
        );
        await client.query(
          `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "additional_data")
           VALUES ($1, $2, 'Alex', 'alex', '{"unresolvedSpeaker": true}'::jsonb)`,
          [newTypeId("node_metadata"), id],
        );
      }

      const result = await runDedupSweep(userId, database);
      expect(result.mergedGroups).toBe(0);
      expect(result.mergedNodes).toBe(0);

      const remaining = await client.query<{ id: string }>(
        `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
        [userId],
      );
      expect(remaining.rows.map((r) => r.id).sort()).toEqual(
        [placeholderA, placeholderB].sort(),
      );
    } finally {
      await client.end();
    }
  });

  it("dedupes identical claims keeping earliest createdAt", async () => {
    const userId = "user_dedup_D";
    const keepId = newTypeId("node");
    const removeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const earliestClaimId = newTypeId("claim");
    const laterClaimId = newTypeId("claim");
    const earliestCreatedAt = new Date("2026-04-01T00:00:00.000Z");
    const laterCreatedAt = new Date("2026-04-05T00:00:00.000Z");
    const statedAt = new Date("2026-04-01T00:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createDedupTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'manual', 'manual:user_dedup_D', 'personal', 'completed')`,
        [sourceId, userId],
      );
      await seedNode(client, {
        userId,
        nodeId: keepId,
        nodeType: "Person",
        canonicalLabel: "carol",
      });
      await seedNode(client, {
        userId,
        nodeId: removeId,
        nodeType: "Person",
        canonicalLabel: "carol",
      });

      // Both claims identical on every dedupe key (same subject post-rewire,
      // predicate, source, object_value, asserted_by_kind, asserted_by_node_id);
      // only created_at differs.
      await client.query(
        `INSERT INTO "claims" (
           "id", "user_id", "subject_node_id", "object_value", "predicate", "statement",
           "source_id", "scope", "asserted_by_kind", "stated_at", "created_at", "updated_at"
         ) VALUES
           ($1, $5, $2, 'tea', 'HAS_PREFERENCE', 'Carol likes tea.', $4, 'personal', 'user', $6, $7, $7),
           ($3, $5, $8, 'tea', 'HAS_PREFERENCE', 'Carol likes tea.', $4, 'personal', 'user', $6, $9, $9)`,
        [
          earliestClaimId,
          keepId,
          laterClaimId,
          sourceId,
          userId,
          statedAt,
          earliestCreatedAt,
          removeId,
          laterCreatedAt,
        ],
      );

      const result = await runDedupSweep(userId, database);
      expect(result.mergedGroups).toBe(1);
      expect(result.mergedNodes).toBe(1);

      const claims = await client.query<{ id: string }>(
        `SELECT "id" FROM "claims" WHERE "user_id" = $1`,
        [userId],
      );

      expect(claims.rows).toHaveLength(1);
      expect(claims.rows[0]?.id).toBe(earliestClaimId);
    } finally {
      await client.end();
    }
  });
});
