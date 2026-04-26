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

describeIfServer("claim operations", () => {
  const dbName = `memory_claim_test_${Date.now()}_${Math.floor(
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

  it("deletes once and reactivates the previous single-current claim", async () => {
    const userId = "user_A";
    const subjectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const priorClaimId = newTypeId("claim");
    const activeClaimId = newTypeId("claim");
    const priorAt = new Date("2026-04-01T00:00:00.000Z");
    const activeAt = new Date("2026-04-02T00:00:00.000Z");

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
      `);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type")
           VALUES ($1, $2, 'Object')`,
        [subjectNodeId, userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_A', 'completed')`,
        [sourceId, userId],
      );
      await database.insert(schema.claims).values([
        {
          id: priorClaimId,
          userId,
          subjectNodeId,
          objectValue: "started",
          predicate: "HAS_STATUS",
          statement: "The project started.",
          sourceId,
          assertedByKind: "user",
          statedAt: priorAt,
          validFrom: priorAt,
          validTo: activeAt,
          status: "superseded",
        },
        {
          id: activeClaimId,
          userId,
          subjectNodeId,
          objectValue: "done",
          predicate: "HAS_STATUS",
          statement: "The project completed.",
          sourceId,
          assertedByKind: "user",
          statedAt: activeAt,
          validFrom: activeAt,
          status: "active",
        },
      ]);

      const { deleteClaim } = await import("./claim");
      await expect(deleteClaim(userId, activeClaimId)).resolves.toBe(true);
      await expect(deleteClaim(userId, activeClaimId)).resolves.toBe(false);

      const rows = await client.query<{
        id: string;
        status: string;
        valid_to: Date | null;
      }>(`SELECT id, status, valid_to FROM claims WHERE user_id = $1`, [
        userId,
      ]);

      expect(rows.rows).toEqual([
        {
          id: priorClaimId,
          status: "active",
          valid_to: null,
        },
      ]);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
