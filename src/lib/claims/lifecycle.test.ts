import { applyClaimLifecycle } from "./lifecycle";
import { eq } from "drizzle-orm";
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

describeIfServer("applyClaimLifecycle", () => {
  const dbName = `memory_lifecycle_test_${Date.now()}_${Math.floor(
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

  async function createLifecycleTables(client: Client): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
      CREATE TABLE IF NOT EXISTS "nodes" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "node_type" varchar(50) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
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

  it("supersedes prior active HAS_STATUS claims only", async () => {
    const userId = "user_A";
    const subjectNodeId = newTypeId("node");
    const objectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    const priorStatusId = newTypeId("claim");
    const newStatusId = newTypeId("claim");
    const preferenceId = newTypeId("claim");
    const relationshipId = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createLifecycleTables(client);

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
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES ($1, $2, 'manual', 'manual:user_A', 'completed')
        `,
        [sourceId, userId],
      );

      const [priorStatus, newStatus, preference, relationship] = await database
        .insert(schema.claims)
        .values([
          {
            id: priorStatusId,
            userId,
            subjectNodeId,
            objectValue: "started",
            predicate: "HAS_STATUS",
            statement: "The project started.",
            sourceId,
            assertedByKind: "user",
            statedAt: new Date("2026-04-01T00:00:00.000Z"),
            status: "active",
          },
          {
            id: newStatusId,
            userId,
            subjectNodeId,
            objectValue: "completed",
            predicate: "HAS_STATUS",
            statement: "The project completed.",
            sourceId,
            assertedByKind: "user",
            statedAt: new Date("2026-04-02T00:00:00.000Z"),
            status: "active",
          },
          {
            id: preferenceId,
            userId,
            subjectNodeId,
            objectValue: "tea",
            predicate: "HAS_PREFERENCE",
            statement: "The user likes tea.",
            sourceId,
            assertedByKind: "user",
            statedAt: new Date("2026-04-02T00:00:00.000Z"),
            status: "active",
          },
          {
            id: relationshipId,
            userId,
            subjectNodeId,
            objectNodeId,
            predicate: "TAGGED_WITH",
            statement: "The user is tagged with an object.",
            sourceId,
            assertedByKind: "user",
            statedAt: new Date("2026-04-02T00:00:00.000Z"),
            status: "active",
          },
        ])
        .returning();

      await applyClaimLifecycle(database, [
        newStatus!,
        preference!,
        relationship!,
      ]);

      const rows = await client.query<{
        id: string;
        status: string;
        valid_from: Date | null;
        valid_to: Date | null;
      }>(
        `
          SELECT "id", "status", "valid_from", "valid_to"
          FROM "claims"
          WHERE "user_id" = $1
          ORDER BY "id"
        `,
        [userId],
      );

      const byId = new Map(rows.rows.map((row) => [row.id, row]));
      expect(byId.get(priorStatus!.id)?.status).toBe("superseded");
      expect(byId.get(priorStatus!.id)?.valid_to?.toISOString()).toBe(
        "2026-04-02T00:00:00.000Z",
      );
      expect(byId.get(newStatus!.id)?.status).toBe("active");
      expect(byId.get(newStatus!.id)?.valid_from?.toISOString()).toBe(
        "2026-04-02T00:00:00.000Z",
      );
      expect(byId.get(preference!.id)?.status).toBe("active");
      expect(byId.get(relationship!.id)?.status).toBe("active");
    } finally {
      await client.end();
    }
  });

  it("uses a deterministic winner for same-timestamp HAS_STATUS claims", async () => {
    const userId = "user_C";
    const subjectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const firstStatusId = newTypeId("claim");
    const secondStatusId = newTypeId("claim");
    const statedAt = new Date("2026-04-02T00:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createLifecycleTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES ($1, $2, 'Person')
        `,
        [subjectNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES ($1, $2, 'manual', 'manual:user_C', 'completed')
        `,
        [sourceId, userId],
      );

      const [firstStatus, secondStatus] = await database
        .insert(schema.claims)
        .values([
          {
            id: firstStatusId,
            userId,
            subjectNodeId,
            objectValue: "started",
            predicate: "HAS_STATUS",
            statement: "The project started.",
            sourceId,
            assertedByKind: "user",
            statedAt,
            createdAt: new Date("2026-04-02T00:00:00.001Z"),
            status: "active",
          },
          {
            id: secondStatusId,
            userId,
            subjectNodeId,
            objectValue: "completed",
            predicate: "HAS_STATUS",
            statement: "The project completed.",
            sourceId,
            assertedByKind: "user",
            statedAt,
            createdAt: new Date("2026-04-02T00:00:00.002Z"),
            status: "active",
          },
        ])
        .returning();

      await applyClaimLifecycle(database, [firstStatus!, secondStatus!]);

      const rows = await client.query<{
        id: string;
        status: string;
        valid_to: Date | null;
      }>(
        `
          SELECT "id", "status", "valid_to"
          FROM "claims"
          WHERE "user_id" = $1
          ORDER BY "created_at"
        `,
        [userId],
      );

      expect(rows.rows).toEqual([
        {
          id: firstStatusId,
          status: "superseded",
          valid_to: statedAt,
        },
        {
          id: secondStatusId,
          status: "active",
          valid_to: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it("reactivates the previous HAS_STATUS when the active status is deleted", async () => {
    const userId = "user_D";
    const subjectNodeId = newTypeId("node");
    const oldSourceId = newTypeId("source");
    const deletedSourceId = newTypeId("source");
    const priorStatusId = newTypeId("claim");
    const activeStatusId = newTypeId("claim");
    const previousStatusAt = new Date("2026-04-01T00:00:00.000Z");
    const activeStatusAt = new Date("2026-04-02T00:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
      await createLifecycleTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES ($1, $2, 'Person')
        `,
        [subjectNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES
              ($1, $3, 'manual', 'manual:user_D:old', 'completed'),
              ($2, $3, 'conversation_message', 'msg_D', 'completed')
        `,
        [oldSourceId, deletedSourceId, userId],
      );
      await database.insert(schema.claims).values([
        {
          id: priorStatusId,
          userId,
          subjectNodeId,
          objectValue: "started",
          predicate: "HAS_STATUS",
          statement: "The project started.",
          sourceId: oldSourceId,
          assertedByKind: "user",
          statedAt: previousStatusAt,
          validFrom: previousStatusAt,
          validTo: activeStatusAt,
          status: "superseded",
        },
        {
          id: activeStatusId,
          userId,
          subjectNodeId,
          objectValue: "completed",
          predicate: "HAS_STATUS",
          statement: "The project completed.",
          sourceId: deletedSourceId,
          assertedByKind: "user",
          statedAt: activeStatusAt,
          validFrom: activeStatusAt,
          status: "active",
        },
      ]);

      const [deletedStatus] = await database
        .delete(schema.claims)
        .where(eq(schema.claims.id, activeStatusId))
        .returning();
      await applyClaimLifecycle(database, [deletedStatus!]);

      const rows = await client.query<{
        id: string;
        status: string;
        valid_to: Date | null;
      }>(
        `
          SELECT "id", "status", "valid_to"
          FROM "claims"
          WHERE "user_id" = $1
        `,
        [userId],
      );

      expect(rows.rows).toEqual([
        {
          id: priorStatusId,
          status: "active",
          valid_to: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });
});
