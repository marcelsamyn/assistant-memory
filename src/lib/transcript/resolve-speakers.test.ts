/**
 * DB-integration tests for transcript speaker resolution. Real Postgres; no
 * external services required.
 *
 * Coverage:
 * - Concurrent `resolveSpeakers` calls for the same user produce exactly one
 *   user-self Person row (advisory-lock-guarded bootstrap, PR 4iii).
 * - A reference-scope Person with a matching alias does NOT shadow speaker
 *   resolution; the speaker still routes to the placeholder path.
 */
import { resolveSpeakers } from "./resolve-speakers";
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

async function createSpeakerTables(client: Client): Promise<void> {
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
      CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
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

describeIfServer("resolveSpeakers", () => {
  const dbName = `memory_resolve_speakers_test_${Date.now()}_${Math.floor(
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

  it("ensures only one user-self Person under concurrent bootstrap", async () => {
    const userId = "user_resolve_concurrent";

    // Two independent connections so the two `resolveSpeakers` calls run in
    // separate sessions — exercising the cross-session race the advisory lock
    // is meant to serialize. Sharing a single client would funnel both calls
    // through the same backend and miss the race entirely.
    const setupClient = new Client({ connectionString: dsnFor(dbName) });
    const clientA = new Client({ connectionString: dsnFor(dbName) });
    const clientB = new Client({ connectionString: dsnFor(dbName) });
    await setupClient.connect();
    await clientA.connect();
    await clientB.connect();

    try {
      await createSpeakerTables(setupClient);
      await setupClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [
        userId,
      ]);

      const dbA = drizzle(clientA, { schema, casing: "snake_case" });
      const dbB = drizzle(clientB, { schema, casing: "snake_case" });

      const [mapA, mapB] = await Promise.all([
        resolveSpeakers({
          db: dbA,
          userId,
          speakerLabels: ["Marcel"],
          userSelfAliases: ["Marcel"],
        }),
        resolveSpeakers({
          db: dbB,
          userId,
          speakerLabels: ["Marcel"],
          userSelfAliases: ["Marcel"],
        }),
      ]);

      const userSelfRows = await setupClient.query<{ id: string }>(
        `SELECT n.id
         FROM nodes n
         JOIN node_metadata nm ON nm.node_id = n.id
         WHERE n.user_id = $1
           AND n.node_type = 'Person'
           AND (nm.additional_data ->> 'isUserSelf') = 'true'`,
        [userId],
      );
      expect(userSelfRows.rows).toHaveLength(1);

      const resolvedA = mapA.get("Marcel");
      const resolvedB = mapB.get("Marcel");
      expect(resolvedA?.isUserSelf).toBe(true);
      expect(resolvedB?.isUserSelf).toBe(true);
      expect(resolvedA?.nodeId).toBe(userSelfRows.rows[0]?.id);
      expect(resolvedB?.nodeId).toBe(userSelfRows.rows[0]?.id);
    } finally {
      await clientA.end();
      await clientB.end();
      await setupClient.end();
    }
  });

  it("does not resolve a speaker to a reference-scope alias match", async () => {
    const userId = "user_resolve_scope";
    const referencePersonId = newTypeId("node");
    const referenceSourceId = newTypeId("source");
    const referenceSourceLinkId = newTypeId("source_link");
    const aliasId = newTypeId("alias");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();

    try {
      await createSpeakerTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      // Reference-scope Person "Alex" — e.g. extracted from a reference doc.
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [referencePersonId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
         VALUES ($1, $2, 'Alex', 'alex')`,
        [newTypeId("node_metadata"), referencePersonId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
         VALUES ($1, $2, 'document', 'doc:reference:alex', 'reference', 'completed')`,
        [referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES ($1, $2, $3)`,
        [referenceSourceLinkId, referenceSourceId, referencePersonId],
      );
      await client.query(
        `INSERT INTO "aliases" ("id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id")
         VALUES ($1, $2, 'Alex', 'alex', $3)`,
        [aliasId, userId, referencePersonId],
      );

      const database = drizzle(client, { schema, casing: "snake_case" });

      const map = await resolveSpeakers({
        db: database,
        userId,
        speakerLabels: ["Alex"],
        userSelfAliases: [],
      });

      const resolved = map.get("Alex");
      expect(resolved).toBeDefined();
      expect(resolved?.resolution).toBe("placeholder");
      expect(resolved?.nodeId).not.toBe(referencePersonId);

      // Two Person nodes now exist for this user: the original reference one
      // plus the new placeholder. The placeholder carries `unresolvedSpeaker`.
      const personRows = await client.query<{
        id: string;
        additional_data: Record<string, unknown> | null;
      }>(
        `SELECT n.id, nm.additional_data
         FROM nodes n
         JOIN node_metadata nm ON nm.node_id = n.id
         WHERE n.user_id = $1 AND n.node_type = 'Person'
         ORDER BY n.id`,
        [userId],
      );
      expect(personRows.rows).toHaveLength(2);
      const placeholder = personRows.rows.find(
        (row) => row.id === resolved?.nodeId,
      );
      expect(placeholder?.additional_data).toMatchObject({
        unresolvedSpeaker: true,
      });
    } finally {
      await client.end();
    }
  });
});
