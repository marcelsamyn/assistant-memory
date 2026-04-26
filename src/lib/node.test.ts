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
            "predicate", "statement", "source_id", "stated_at", "status"
          )
          VALUES
            ($1, $6, $3, $4, 'OWNED_BY', 'Alice owns a MacBook Pro.', $5, now(), 'active'),
            ($2, $6, $3, $4, 'TAGGED_WITH', 'Alice was tagged with a MacBook Pro.', $5, now(), 'retracted')
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
});
