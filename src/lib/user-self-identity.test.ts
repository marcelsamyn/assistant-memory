import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import {
  buildUserIdentityNote,
  distinguishingAliases,
  selectPrimarySelfLabel,
} from "./user-self-identity";

describe("selectPrimarySelfLabel", () => {
  it("picks the alias with the most tokens", () => {
    expect(selectPrimarySelfLabel(["Marcel", "Marcel Samyn"])).toBe(
      "Marcel Samyn",
    );
  });

  it("returns null when only single-token aliases are present", () => {
    expect(selectPrimarySelfLabel(["Marcel"])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectPrimarySelfLabel([])).toBeNull();
  });

  it("prefers the longest string when token counts tie", () => {
    expect(selectPrimarySelfLabel(["Jo Lee", "Joanna Lee"])).toBe("Joanna Lee");
  });
});

describe("distinguishingAliases", () => {
  it("keeps only multi-token aliases, de-duplicated by normalized form", () => {
    expect(
      distinguishingAliases(["Marcel", "Marcel Samyn", "marcel samyn"]),
    ).toEqual(["Marcel Samyn"]);
  });

  it("drops bare single-token names", () => {
    expect(distinguishingAliases(["Marcel", "MS"])).toEqual([]);
  });
});

describe("buildUserIdentityNote", () => {
  it("returns null when there are no aliases", () => {
    expect(buildUserIdentityNote([])).toBeNull();
  });

  it("names the primary, lists aliases, and warns against conflation", () => {
    const note = buildUserIdentityNote(["Marcel", "Marcel Samyn"]);
    expect(note).toContain("Marcel Samyn");
    expect(note).toContain("most specific");
    expect(note).toContain("share a first name");
  });
});

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

async function createIdentityHygieneTables(client: Client): Promise<void> {
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
    CREATE TABLE IF NOT EXISTS "aliases" (
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
}

describeIfServer("ensureUserSelfIdentity", () => {
  const dbName = `memory_self_identity_test_${Date.now()}_${Math.floor(
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

  it("names the self node with the full name and seeds only multi-token aliases", async () => {
    const userId = "user_self_identity_a";
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      await createIdentityHygieneTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      const database = drizzle(client, { schema, casing: "snake_case" });

      const { ensureUserSelfIdentity } = await import("./user-self-identity");
      const nodeId = await ensureUserSelfIdentity(database, userId, [
        "Marcel",
        "Marcel Samyn",
      ]);

      const meta = await client.query<{
        label: string;
        canonical_label: string;
        additional_data: Record<string, unknown> | null;
      }>(
        `SELECT label, canonical_label, additional_data FROM node_metadata WHERE node_id = $1`,
        [nodeId],
      );
      expect(meta.rows[0]?.label).toBe("Marcel Samyn");
      expect(meta.rows[0]?.canonical_label).toBe("marcel samyn");
      expect(meta.rows[0]?.additional_data).toMatchObject({ isUserSelf: true });

      const aliasRows = await client.query<{ normalized_alias_text: string }>(
        `SELECT normalized_alias_text FROM aliases WHERE user_id = $1 AND canonical_node_id = $2`,
        [userId, nodeId],
      );
      const normalized = aliasRows.rows.map((r) => r.normalized_alias_text);
      expect(normalized).toContain("marcel samyn");
      expect(normalized).not.toContain("marcel");

      // Idempotent: a second call adds nothing and keeps a single self node.
      const nodeId2 = await ensureUserSelfIdentity(database, userId, [
        "Marcel",
        "Marcel Samyn",
      ]);
      expect(nodeId2).toBe(nodeId);
      const selfCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM node_metadata
         WHERE (additional_data ->> 'isUserSelf') = 'true'`,
      );
      expect(selfCount.rows[0]?.count).toBe("1");
    } finally {
      await client.end();
    }
  });

  it("leaves the label unchanged when only single-token aliases are given", async () => {
    const userId = "user_self_identity_b";
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      await createIdentityHygieneTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      const database = drizzle(client, { schema, casing: "snake_case" });

      const { ensureUserSelfIdentity } = await import("./user-self-identity");
      const nodeId = await ensureUserSelfIdentity(database, userId, ["Marcel"]);

      const meta = await client.query<{ label: string }>(
        `SELECT label FROM node_metadata WHERE node_id = $1`,
        [nodeId],
      );
      // No multi-token alias → primary label stays the placeholder (userId).
      expect(meta.rows[0]?.label).toBe(userId);

      const aliasRows = await client.query<{ id: string }>(
        `SELECT id FROM aliases WHERE user_id = $1 AND canonical_node_id = $2`,
        [userId, nodeId],
      );
      expect(aliasRows.rows).toHaveLength(0);
    } finally {
      await client.end();
    }
  });
});
