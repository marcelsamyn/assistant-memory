import {
  createAlias,
  deleteAlias,
  listAliasesForNodeIds,
  normalizeAliasText,
} from "./alias";
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

const nodeA = newTypeId("node");
const nodeB = newTypeId("node");

describe("normalizeAliasText", () => {
  it("trims and lowercases only", () => {
    expect(normalizeAliasText("  MBP  ")).toBe("mbp");
  });
});

describeIfServer("alias service", () => {
  const dbName = `memory_alias_test_${Date.now()}_${Math.floor(
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

  it("creates, deduplicates, lists, and deletes aliases by owner", async () => {
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

      await client.query(
        `INSERT INTO "users" ("id") VALUES ('user_A'), ('user_B')`,
      );
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, 'user_A', 'Object'),
              ($2, 'user_B', 'Object')
        `,
        [nodeA, nodeB],
      );

      const first = await createAlias(database, {
        userId: "user_A",
        canonicalNodeId: nodeA,
        aliasText: "  MBP  ",
      });

      const duplicate = await createAlias(database, {
        userId: "user_A",
        canonicalNodeId: nodeA,
        aliasText: "mbp",
      });

      expect(duplicate.id).toBe(first.id);
      expect(first.normalizedAliasText).toBe("mbp");

      const listed = await listAliasesForNodeIds(database, "user_A", [nodeA]);
      expect(listed.get(nodeA)).toHaveLength(1);
      expect(listed.get(nodeA)?.[0]?.aliasText).toBe("  MBP  ");

      await expect(
        createAlias(database, {
          userId: "user_A",
          canonicalNodeId: nodeB,
          aliasText: "their node",
        }),
      ).rejects.toThrow("Canonical node not found");

      expect(await deleteAlias(database, "user_B", first.id)).toBe(false);
      expect(await deleteAlias(database, "user_A", first.id)).toBe(true);

      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM aliases`,
      );
      expect(count.rows[0]?.count).toBe("0");
    } finally {
      await client.end();
    }
  });
});
