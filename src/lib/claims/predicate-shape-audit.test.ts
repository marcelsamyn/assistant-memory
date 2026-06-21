import { auditRelationshipPredicateHealth } from "./predicate-shape-audit";
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

describeIfServer("auditRelationshipPredicateHealth", () => {
  const dbName = `memory_predicate_health_test_${Date.now()}_${Math.floor(
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

  it("reports shape violations, deprecated predicates, repair proposals, and prompt size", async () => {
    const userId = "user_predicate_health";
    const sourceId = newTypeId("source");
    const person = newTypeId("node");
    const event = newTypeId("node");
    const day = newTypeId("node");
    const object = newTypeId("node");
    const claimIds = {
      invertedDate: newTypeId("claim"),
      deprecatedOwnership: newTypeId("claim"),
      invalidLocation: newTypeId("claim"),
      validDate: newTypeId("claim"),
    };

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const db = drizzle(client, { schema, casing: "snake_case" });

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
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
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
          "status" varchar(20) DEFAULT 'completed',
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
          "object_instant" timestamp with time zone,
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

      await db.insert(schema.users).values({ id: userId });
      await db.insert(schema.sources).values({
        id: sourceId,
        userId,
        type: "manual",
        externalId: "manual:user_predicate_health",
        scope: "personal",
        status: "completed",
      });
      await db.insert(schema.nodes).values([
        { id: person, userId, nodeType: "Person" },
        { id: event, userId, nodeType: "Event" },
        { id: day, userId, nodeType: "Temporal" },
        { id: object, userId, nodeType: "Object" },
      ]);
      await db.insert(schema.nodeMetadata).values([
        { id: newTypeId("node_metadata"), nodeId: person, label: "Taylor" },
        { id: newTypeId("node_metadata"), nodeId: event, label: "Workshop" },
        { id: newTypeId("node_metadata"), nodeId: day, label: "2026-06-19" },
        { id: newTypeId("node_metadata"), nodeId: object, label: "Notebook" },
      ]);
      await client.query(
        `INSERT INTO "claims"
          ("id", "user_id", "subject_node_id", "object_node_id", "predicate", "statement", "source_id", "scope", "asserted_by_kind", "stated_at", "status")
         VALUES
          ($1, $5, $9, $8, 'OCCURRED_ON', 'The workshop happened on 2026-06-19.', $6, 'personal', 'user', now(), 'active'),
          ($2, $5, $8, $9, 'OCCURRED_ON', 'The workshop happened on 2026-06-19.', $6, 'personal', 'user', now(), 'active'),
          ($3, $5, $7, $10, 'LOCATED_IN', 'Taylor likes the notebook.', $6, 'personal', 'user', now(), 'active'),
          ($4, $5, $10, $7, 'OWNED_BY', 'The notebook is owned by Taylor.', $6, 'personal', 'user', now(), 'active')`,
        [
          claimIds.invertedDate,
          claimIds.validDate,
          claimIds.invalidLocation,
          claimIds.deprecatedOwnership,
          userId,
          sourceId,
          person,
          event,
          day,
          object,
        ],
      );

      const report = await auditRelationshipPredicateHealth(db, userId, {
        exampleLimit: 10,
      });

      expect(report.invalidShapes.totalInvalid).toBe(2);
      expect(report.deprecatedPredicates).toEqual([
        { predicate: "OWNED_BY", count: 1 },
      ]);
      expect(report.repairProposals).toHaveLength(2);
      expect(
        report.repairProposals.map((proposal) => proposal.claimId),
      ).toEqual(
        expect.arrayContaining([
          claimIds.invertedDate,
          claimIds.deprecatedOwnership,
        ]),
      );
      expect(report.promptGuide.characterCount).toBeGreaterThan(1000);
      expect(report.promptGuide.approximateTokenCount).toBeGreaterThan(250);
      expect(report.promptGuide.lineCount).toBeGreaterThan(10);
    } finally {
      await client.end();
    }
  });
});
