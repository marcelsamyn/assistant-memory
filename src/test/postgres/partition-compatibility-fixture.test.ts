import { installPartitionCompatibilityFixture } from "./partition-compatibility-fixture";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { assertPartitionReadAllowed } from "~/lib/partition-access";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

const adminDsn = (): string =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;

const dsnFor = (databaseName: string): string =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${databaseName}`;

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

describeIfServer("partition compatibility fixture", () => {
  const databaseName = `memory_partition_fixture_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    await admin.end();
  });

  afterAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  });

  it("keeps legacy access open until migration starts and is idempotent", async () => {
    const client = new Client({ connectionString: dsnFor(databaseName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    const partitionKey = contextPartitionKeySchema.parse("room:client-a");

    try {
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL,
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "sources" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL,
          "type" varchar(50) NOT NULL,
          "external_id" text NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "claims" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "aliases" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "node_redirects" (
          "user_id" text NOT NULL,
          "from_node_id" text NOT NULL,
          PRIMARY KEY ("user_id", "from_node_id")
        );
      `);

      await installPartitionCompatibilityFixture(client);
      await installPartitionCompatibilityFixture(client);

      await client.query(`INSERT INTO "users" ("id") VALUES ('legacy-user')`);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type")
         VALUES ('legacy-node', 'legacy-user', 'Object')`,
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
         VALUES ('legacy-source', 'legacy-user', 'manual', 'manual:legacy')`,
      );

      const fixtureRows = await client.query<{
        nodePartitionKey: string | null;
        sourcePartitionKey: string | null;
        sourceVersion: number;
      }>(`
        SELECT
          n."partition_key" AS "nodePartitionKey",
          s."partition_key" AS "sourcePartitionKey",
          s."version" AS "sourceVersion"
        FROM "nodes" n
        CROSS JOIN "sources" s
      `);
      expect(fixtureRows.rows).toEqual([
        {
          nodePartitionKey: null,
          sourcePartitionKey: null,
          sourceVersion: 0,
        },
      ]);

      await expect(
        assertPartitionReadAllowed(database, "legacy-user", undefined),
      ).resolves.toBeUndefined();

      await client.query(
        `INSERT INTO "partition_migration_state" ("user_id", "state")
         VALUES ('legacy-user', 'migrating')`,
      );
      await expect(
        assertPartitionReadAllowed(database, "legacy-user", undefined),
      ).rejects.toMatchObject({ code: "PARTITION_REQUIRED" });

      await client.query(
        `INSERT INTO "memory_partitions" ("user_id", "partition_key")
         VALUES ('legacy-user', $1)`,
        [partitionKey],
      );
      await expect(
        assertPartitionReadAllowed(database, "legacy-user", partitionKey),
      ).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });
});
