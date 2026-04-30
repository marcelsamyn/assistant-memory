/**
 * DB fixture for the memory regression eval harness.
 *
 * Mirrors the hand-rolled DDL approach used by `cleanup-operations.test.ts`
 * and `ingest-transcript.test.ts`: real Postgres on the non-default test
 * port (5431 by default), no migrator, no pgvector. Each call to
 * `createEvalDatabase` returns a freshly-named database so concurrent stories
 * don't collide. Tear it down with the returned `cleanup` callback.
 *
 * Common aliases: eval test database, harness fixture, scope-bounded claims
 * tables, regression DDL.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "~/db/schema";

export const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
export const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
export const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
export const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
export const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

export function adminDsn(): string {
  return `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
}

export function dsnFor(dbName: string): string {
  return `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${dbName}`;
}

export async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn() });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

export interface EvalDatabase {
  dbName: string;
  client: Client;
  db: NodePgDatabase<typeof schema>;
  cleanup: () => Promise<void>;
}

const HARNESS_DDL = `
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
    UNIQUE ("node_id")
  );
  CREATE TABLE IF NOT EXISTS "sources" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "type" varchar(50) NOT NULL,
    "external_id" text NOT NULL,
    "parent_source" text,
    "scope" varchar(16) DEFAULT 'personal' NOT NULL,
    "metadata" jsonb,
    "last_ingested_at" timestamp with time zone,
    "status" varchar(20) DEFAULT 'completed',
    "content_type" varchar(100),
    "content_length" integer,
    "deleted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    UNIQUE ("user_id", "type", "external_id")
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
      CHECK (num_nonnulls("object_node_id", "object_value") = 1),
    CONSTRAINT "claims_asserted_by_node_consistency_ck"
      CHECK (("asserted_by_kind" = 'participant' AND "asserted_by_node_id" IS NOT NULL)
             OR "asserted_by_kind" <> 'participant')
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
  CREATE TABLE IF NOT EXISTS "user_profiles" (
    "id" text PRIMARY KEY NOT NULL,
    "user_id" text NOT NULL REFERENCES "users"("id"),
    "content" text NOT NULL DEFAULT '',
    "metadata" jsonb NOT NULL DEFAULT '{}',
    "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );
`;

let dbCounter = 0;

/**
 * Create a freshly-named test database, run the harness DDL, and return a
 * connected drizzle instance plus a cleanup callback. The cleanup callback
 * terminates lingering connections and drops the database.
 */
export async function createEvalDatabase(prefix: string): Promise<EvalDatabase> {
  dbCounter += 1;
  const dbName = `memory_eval_${prefix}_${Date.now()}_${process.pid}_${dbCounter}`;

  const admin = new Client({ connectionString: adminDsn() });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const client = new Client({ connectionString: dsnFor(dbName) });
  await client.connect();
  await client.query(HARNESS_DDL);

  const db = drizzle(client, { schema, casing: "snake_case" });

  const cleanup = async (): Promise<void> => {
    try {
      await client.end();
    } catch {
      /* connection already closed */
    }
    const adminAgain = new Client({ connectionString: adminDsn() });
    await adminAgain.connect();
    await adminAgain.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminAgain.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await adminAgain.end();
  };

  return { dbName, client, db, cleanup };
}
