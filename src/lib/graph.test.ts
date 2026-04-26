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

process.env["DATABASE_URL"] ??= adminDsn();
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
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

describeIfServer("graph claim operations", () => {
  const dbName = `memory_graph_test_${Date.now()}_${Math.floor(
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

  it("uses only active relationship claims for graph traversal", async () => {
    const { fetchClaimsBetweenNodeIds, findOneHopNodes } = await import(
      "./graph"
    );
    const userId = "user_A";
    const aliceNodeId = newTypeId("node");
    const laptopNodeId = newTypeId("node");
    const hiddenNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const activeRelationshipClaimId = newTypeId("claim");
    const retractedRelationshipClaimId = newTypeId("claim");
    const attributeClaimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

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
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, $4, 'Person'),
              ($2, $4, 'Object'),
              ($3, $4, 'Object')
        `,
        [aliceNodeId, laptopNodeId, hiddenNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $4, 'Alice', 'alice', 'Person profile'),
              ($2, $5, 'MacBook Pro', 'macbook pro', 'Laptop profile'),
              ($3, $6, 'Hidden Item', 'hidden item', 'Hidden profile')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          aliceNodeId,
          laptopNodeId,
          hiddenNodeId,
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
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id", "object_value",
            "predicate", "statement", "source_id", "stated_at", "status"
          )
          VALUES
            ($1, $8, $4, $5, NULL, 'OWNED_BY', 'Alice owns a MacBook Pro.', $7, now(), 'active'),
            ($2, $8, $4, $6, NULL, 'TAGGED_WITH', 'Alice was tagged with Hidden Item.', $7, now(), 'retracted'),
            ($3, $8, $4, NULL, 'busy', 'HAS_STATUS', 'Alice is busy.', $7, now(), 'active')
        `,
        [
          activeRelationshipClaimId,
          retractedRelationshipClaimId,
          attributeClaimId,
          aliceNodeId,
          laptopNodeId,
          hiddenNodeId,
          sourceId,
          userId,
        ],
      );

      const oneHopNodes = await findOneHopNodes(database, userId, [
        aliceNodeId,
      ]);
      expect(oneHopNodes).toHaveLength(1);
      expect(oneHopNodes[0]).toMatchObject({
        id: laptopNodeId,
        label: "MacBook Pro",
        predicate: "OWNED_BY",
        statement: "Alice owns a MacBook Pro.",
        claimSubjectId: aliceNodeId,
        claimObjectId: laptopNodeId,
        subjectLabel: "Alice",
        objectLabel: "MacBook Pro",
      });

      const claimsBetween = await fetchClaimsBetweenNodeIds(database, userId, [
        aliceNodeId,
        laptopNodeId,
        hiddenNodeId,
      ]);
      expect(claimsBetween).toHaveLength(1);
      expect(claimsBetween[0]).toMatchObject({
        id: activeRelationshipClaimId,
        subject: aliceNodeId,
        object: laptopNodeId,
        predicate: "OWNED_BY",
        status: "active",
      });
    } finally {
      await client.end();
    }
  });
});
