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
    const referenceNodeId = newTypeId("node");
    const inferredNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");
    const activeRelationshipClaimId = newTypeId("claim");
    const retractedRelationshipClaimId = newTypeId("claim");
    const referenceRelationshipClaimId = newTypeId("claim");
    const inferredRelationshipClaimId = newTypeId("claim");
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
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
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

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, $6, 'Person'),
              ($2, $6, 'Object'),
              ($3, $6, 'Object'),
              ($4, $6, 'Object'),
              ($5, $6, 'Object')
        `,
        [
          aliceNodeId,
          laptopNodeId,
          hiddenNodeId,
          referenceNodeId,
          inferredNodeId,
          userId,
        ],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $6, 'Alice', 'alice', 'Person profile'),
              ($2, $7, 'MacBook Pro', 'macbook pro', 'Laptop profile'),
              ($3, $8, 'Hidden Item', 'hidden item', 'Hidden profile'),
              ($4, $9, 'Reference Item', 'reference item', 'Reference profile'),
              ($5, $10, 'Inferred Item', 'inferred item', 'Inferred profile')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          aliceNodeId,
          laptopNodeId,
          hiddenNodeId,
          referenceNodeId,
          inferredNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
            VALUES
              ($1, $3, 'manual', 'manual:user_A', 'personal', 'completed'),
              ($2, $3, 'document', 'doc:user_A', 'reference', 'completed')
        `,
        [sourceId, referenceSourceId, userId],
      );
      await client.query(
        `
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id", "object_value",
            "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status"
          )
          VALUES
            ($1, $11, $6, $7, NULL, 'OWNED_BY', 'Alice owns a MacBook Pro.', $10, 'personal', 'user', now(), 'active'),
            ($2, $11, $6, $8, NULL, 'TAGGED_WITH', 'Alice was tagged with Hidden Item.', $10, 'personal', 'user', now(), 'retracted'),
            ($3, $11, $6, NULL, 'busy', 'HAS_STATUS', 'Alice is busy.', $10, 'personal', 'user', now(), 'active'),
            ($4, $11, $6, $9, NULL, 'RELATED_TO', 'Alice is related to a reference item.', $12, 'reference', 'document_author', now(), 'active'),
            ($5, $11, $6, $13, NULL, 'RELATED_TO', 'Alice is related to an inferred item.', $10, 'personal', 'assistant_inferred', now(), 'active')
        `,
        [
          activeRelationshipClaimId,
          retractedRelationshipClaimId,
          attributeClaimId,
          referenceRelationshipClaimId,
          inferredRelationshipClaimId,
          aliceNodeId,
          laptopNodeId,
          hiddenNodeId,
          referenceNodeId,
          sourceId,
          userId,
          referenceSourceId,
          inferredNodeId,
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

      const oneHopWithReference = await findOneHopNodes(
        database,
        userId,
        [aliceNodeId],
        { includeReference: true },
      );
      expect(oneHopWithReference.map((node) => node.id).sort()).toEqual(
        [laptopNodeId, referenceNodeId].sort(),
      );

      const oneHopWithInferred = await findOneHopNodes(
        database,
        userId,
        [aliceNodeId],
        { includeAssistantInferred: true },
      );
      expect(oneHopWithInferred.map((node) => node.id).sort()).toEqual(
        [inferredNodeId, laptopNodeId].sort(),
      );

      const claimsBetween = await fetchClaimsBetweenNodeIds(database, userId, [
        aliceNodeId,
        laptopNodeId,
        hiddenNodeId,
        referenceNodeId,
        inferredNodeId,
      ]);
      expect(claimsBetween.map((claim) => claim.id).sort()).toEqual(
        [
          activeRelationshipClaimId,
          inferredRelationshipClaimId,
          referenceRelationshipClaimId,
        ].sort(),
      );
    } finally {
      await client.end();
    }
  });

  it("filters semantic claim search to personal non-inferred claims by default", async () => {
    const userId = "user_B";
    const subjectNodeId = newTypeId("node");
    const objectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");
    const personalClaimId = newTypeId("claim");
    const referenceClaimId = newTypeId("claim");
    const inferredClaimId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
      await client.query(`
        DROP TABLE IF EXISTS
          "claim_embeddings",
          "claims",
          "node_metadata",
          "nodes",
          "sources",
          "users"
        CASCADE
      `);
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
        CREATE TABLE "claim_embeddings" (
          "id" text PRIMARY KEY NOT NULL,
          "claim_id" text NOT NULL REFERENCES "claims"("id") ON DELETE CASCADE,
          "embedding" vector(1024) NOT NULL,
          "model_name" varchar(100) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES ($1, $3, 'Person'), ($2, $3, 'Object')
        `,
        [subjectNodeId, objectNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $3, 'Alice', 'alice', 'Person profile'),
              ($2, $4, 'MacBook Pro', 'macbook pro', 'Laptop profile')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          subjectNodeId,
          objectNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
            VALUES
              ($1, $3, 'manual', 'manual:user_B', 'personal', 'completed'),
              ($2, $3, 'document', 'doc:user_B', 'reference', 'completed')
        `,
        [sourceId, referenceSourceId, userId],
      );
      await client.query(
        `
          INSERT INTO "claims" (
            "id", "user_id", "subject_node_id", "object_node_id",
            "predicate", "statement", "source_id", "scope",
            "asserted_by_kind", "stated_at", "status"
          )
          VALUES
            ($1, $8, $4, $5, 'OWNED_BY', 'Alice owns a MacBook Pro.', $6, 'personal', 'user', now(), 'active'),
            ($2, $8, $4, $5, 'RELATED_TO', 'Alice is related to reference content.', $7, 'reference', 'document_author', now(), 'active'),
            ($3, $8, $4, $5, 'TAGGED_WITH', 'Assistant inferred this relation.', $6, 'personal', 'assistant_inferred', now(), 'active')
        `,
        [
          personalClaimId,
          referenceClaimId,
          inferredClaimId,
          subjectNodeId,
          objectNodeId,
          sourceId,
          referenceSourceId,
          userId,
        ],
      );
      await client.query(
        `
          INSERT INTO "claim_embeddings" ("id", "claim_id", "embedding", "model_name")
          VALUES
            ($1, $4, array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector, 'test'),
            ($2, $5, array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector, 'test'),
            ($3, $6, array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector, 'test')
        `,
        [
          newTypeId("claim_embedding"),
          newTypeId("claim_embedding"),
          newTypeId("claim_embedding"),
          personalClaimId,
          referenceClaimId,
          inferredClaimId,
        ],
      );

      const { findSimilarClaims } = await import("./graph");
      const embedding = [1, ...Array.from({ length: 1023 }, () => 0)];

      await expect(
        findSimilarClaims({ userId, embedding, limit: 10 }),
      ).resolves.toHaveLength(1);
      await expect(
        findSimilarClaims({
          userId,
          embedding,
          limit: 10,
          includeReference: true,
        }),
      ).resolves.toHaveLength(2);
      await expect(
        findSimilarClaims({
          userId,
          embedding,
          limit: 10,
          includeAssistantInferred: true,
        }),
      ).resolves.toHaveLength(2);
      await expect(
        findSimilarClaims({
          userId,
          embedding,
          limit: 10,
          includeReference: true,
          includeAssistantInferred: true,
        }),
      ).resolves.toHaveLength(3);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("filters semantic node search to personal-supported nodes by default", async () => {
    const userId = "user_C";
    const personalNodeId = newTypeId("node");
    const referenceNodeId = newTypeId("node");
    const personalSourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
      await client.query(`
        DROP TABLE IF EXISTS
          "node_embeddings",
          "source_links",
          "claims",
          "node_metadata",
          "nodes",
          "sources",
          "users"
        CASCADE
      `);
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
        CREATE TABLE "source_links" (
          "id" text PRIMARY KEY NOT NULL,
          "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "specific_location" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "source_links_source_id_node_id_unique" UNIQUE ("source_id", "node_id")
        );
        CREATE TABLE "node_embeddings" (
          "id" text PRIMARY KEY NOT NULL,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "embedding" vector(1024) NOT NULL,
          "model_name" varchar(100) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES ($1, $3, 'Concept'), ($2, $3, 'Concept')
        `,
        [personalNodeId, referenceNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $3, 'Personal Planning', 'personal planning', 'User-specific planning context'),
              ($2, $4, 'Reference Planning', 'reference planning', 'Book excerpt planning context')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personalNodeId,
          referenceNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
            VALUES
              ($1, $3, 'document', 'personal-doc', 'personal', 'completed'),
              ($2, $3, 'document', 'reference-doc', 'reference', 'completed')
        `,
        [personalSourceId, referenceSourceId, userId],
      );
      await client.query(
        `
          INSERT INTO "source_links" ("id", "source_id", "node_id")
            VALUES
              ($1, $3, $5),
              ($2, $4, $6)
        `,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          personalSourceId,
          referenceSourceId,
          personalNodeId,
          referenceNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "node_embeddings" ("id", "node_id", "embedding", "model_name")
          VALUES
            ($1, $3, array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector, 'test'),
            ($2, $4, array_prepend(1::real, array_fill(0::real, ARRAY[1023]))::vector, 'test')
        `,
        [
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          personalNodeId,
          referenceNodeId,
        ],
      );

      const { findSimilarNodes } = await import("./graph");
      const embedding = [1, ...Array.from({ length: 1023 }, () => 0)];

      await expect(
        findSimilarNodes({ userId, embedding, limit: 10 }),
      ).resolves.toMatchObject([{ id: personalNodeId }]);
      await expect(
        findSimilarNodes({
          userId,
          embedding,
          limit: 10,
          includeReference: true,
        }),
      ).resolves.toHaveLength(2);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
