import { writeNodeRedirects } from "./node-redirects";
import { resolveCitations } from "./resolve-citations";
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

describeIfServer("resolveCitations", () => {
  const dbName = `memory_resolve_test_${Date.now()}_${Math.floor(
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

  it("resolves nodes (with redirects), claims (+ provenance), sources, and marks missing unavailable", async () => {
    const userId = "user_A";
    const liveNode = newTypeId("node");
    const mergedAway = newTypeId("node");
    const missingNode = newTypeId("node");
    const src1 = newTypeId("source");
    const src2 = newTypeId("source");
    const srcDeleted = newTypeId("source");
    const claim1 = newTypeId("claim");
    const claimSuperseded = newTypeId("claim");

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
          "metadata" jsonb,
          "status" varchar(20) DEFAULT 'completed',
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "deleted_at" timestamp with time zone,
          CONSTRAINT "sources_user_type_external_unique"
            UNIQUE ("user_id","type","external_id")
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
          "superseded_by_claim_id" text,
          "contradicted_by_claim_id" text,
          "stated_at" timestamp with time zone NOT NULL,
          "valid_from" timestamp with time zone,
          "valid_to" timestamp with time zone,
          "status" varchar(30) DEFAULT 'active' NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "node_redirects" (
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "from_node_id" text NOT NULL,
          "to_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          CONSTRAINT "node_redirects_user_id_from_node_id_pk"
            PRIMARY KEY ("user_id","from_node_id")
        );
      `);

      await client.query(`INSERT INTO "users" ("id") VALUES ('user_A')`);
      await client.query(
        `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,'user_A','Object')`,
        [liveNode],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id","node_id","label","description") VALUES ($1,$2,'Acme','A company')`,
        [newTypeId("node_metadata"), liveNode],
      );
      await client.query(
        `INSERT INTO "sources" ("id","user_id","type","external_id","metadata") VALUES
          ($1,'user_A','document','ext1',$2),
          ($3,'user_A','meeting_transcript','ext2',$4)`,
        [
          src1,
          JSON.stringify({ title: "2026 plan" }),
          src2,
          JSON.stringify({ title: "Standup" }),
        ],
      );
      await client.query(
        `INSERT INTO "claims"
          ("id","user_id","subject_node_id","object_value","predicate","statement","source_id","asserted_by_kind","stated_at")
         VALUES ($1,'user_A',$2,'Nov 14','HAS_STATUS','Launch moved to Nov 14',$3,'user',now())`,
        [claim1, liveNode, src1],
      );

      // soft-deleted source: row exists but deleted_at is set
      await client.query(
        `INSERT INTO "sources" ("id","user_id","type","external_id","metadata","deleted_at")
         VALUES ($1,'user_A','document','ext_deleted',$2,now())`,
        [srcDeleted, JSON.stringify({ title: "Deleted doc" })],
      );

      // superseded claim: row exists but status is 'superseded'
      await client.query(
        `INSERT INTO "claims"
          ("id","user_id","subject_node_id","object_value","predicate","statement","source_id","asserted_by_kind","stated_at","status")
         VALUES ($1,'user_A',$2,'Oct 1','HAS_STATUS','Launch was Oct 1',$3,'user',now(),'superseded')`,
        [claimSuperseded, liveNode, src1],
      );

      // mergedAway was merged into liveNode (node row gone, redirect remains)
      await writeNodeRedirects(database, userId, liveNode, [mergedAway]);

      const result = await resolveCitations(database, userId, [
        liveNode,
        mergedAway,
        claim1,
        src2,
        missingNode,
        srcDeleted,
        claimSuperseded,
      ]);

      const by = new Map(result.map((r) => [r.requestedId, r]));

      expect(by.get(liveNode)).toMatchObject({
        kind: "node",
        available: true,
        canonicalId: liveNode,
        title: "Acme",
      });
      expect(by.get(mergedAway)).toMatchObject({
        kind: "node",
        available: true,
        canonicalId: liveNode, // followed the redirect
        title: "Acme",
      });
      expect(by.get(claim1)).toMatchObject({
        kind: "claim",
        available: true,
        title: "Launch moved to Nov 14",
        source: { id: src1, title: "2026 plan", type: "document" },
      });
      expect(by.get(src2)).toMatchObject({
        kind: "source",
        available: true,
        title: "Standup",
      });
      expect(by.get(missingNode)).toMatchObject({
        kind: "node",
        available: false,
        canonicalId: null,
        title: null,
      });
      // soft-deleted source: row exists but deleted_at set → unavailable
      expect(by.get(srcDeleted)).toMatchObject({
        kind: "source",
        available: false,
        canonicalId: null,
        title: "Deleted doc",
      });
      // superseded claim: row exists but status !== 'active' → unavailable; title still returned
      expect(by.get(claimSuperseded)).toMatchObject({
        kind: "claim",
        available: false,
        canonicalId: null,
        title: "Launch was Oct 1",
      });
      // input order preserved
      expect(result.map((r) => r.requestedId)).toEqual([
        liveNode,
        mergedAway,
        claim1,
        src2,
        missingNode,
        srcDeleted,
        claimSuperseded,
      ]);
    } finally {
      await client.end();
    }
  });
});
