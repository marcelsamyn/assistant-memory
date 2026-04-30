import { eq } from "drizzle-orm";
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

describeIfServer("runProfileSynthesis", () => {
  const dbName = `memory_profile_synthesis_test_${Date.now()}_${Math.floor(
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

  async function createProfileSynthesisTables(client: Client): Promise<void> {
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
      CREATE TABLE IF NOT EXISTS "sources" (
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
      CREATE TABLE IF NOT EXISTS "source_links" (
        "id" text PRIMARY KEY NOT NULL,
        "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
        "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
        "specific_location" text,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
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

  it("synthesizes a description from trusted claims, ignores assistant_inferred, and short-circuits on a hash cache hit", async () => {
    const userId = "user_profile_basic";
    const personNodeId = newTypeId("node");
    const projectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    let llmCallCount = 0;
    let lastPrompt = "";
    let lastSchemaName: string | undefined;

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("../ai", () => ({
      performStructuredAnalysis: async (input: {
        prompt: string;
        schema: { description?: string };
      }) => {
        llmCallCount += 1;
        lastPrompt = input.prompt;
        lastSchemaName = input.schema.description;
        return {
          description:
            "A senior engineer who prefers concise communication and is currently focused on shipping the claims layer.",
        };
      },
    }));

    try {
      await createProfileSynthesisTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $3, 'Person'),
          ($2, $3, 'Object')`,
        [personNodeId, projectNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description", "additional_data") VALUES
          ($1, $3, 'Marcel', 'marcel', 'Stale prior description.', '{}'::jsonb),
          ($2, $4, 'Claims Layer', 'claims layer', null, '{}'::jsonb)`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personNodeId,
          projectNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status") VALUES
          ($1, $3, 'conversation_message', 'msg_personal', 'personal', 'completed'),
          ($2, $3, 'document', 'doc_reference', 'reference', 'completed')`,
        [sourceId, referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES ($1, $2, $3)`,
        [newTypeId("source_link"), sourceId, personNodeId],
      );
      await client.query(
        `INSERT INTO "aliases" ("id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id") VALUES
          ($1, $2, 'Marc', 'marc', $3)`,
        [newTypeId("alias"), userId, personNodeId],
      );

      const userClaimId = newTypeId("claim");
      const userConfirmedClaimId = newTypeId("claim");
      const assistantInferredClaimId = newTypeId("claim");
      const supersededClaimId = newTypeId("claim");
      const systemRelClaimId = newTypeId("claim");
      const referenceClaimId = newTypeId("claim");

      await database.insert(schema.claims).values([
        {
          id: userClaimId,
          userId,
          subjectNodeId: personNodeId,
          objectValue: "prefers concise communication",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel prefers concise communication.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
        {
          id: userConfirmedClaimId,
          userId,
          subjectNodeId: personNodeId,
          objectValue: "ship the claims layer in Q2",
          predicate: "HAS_GOAL",
          statement: "Marcel will ship the claims layer in Q2.",
          sourceId,
          scope: "personal",
          assertedByKind: "user_confirmed",
          statedAt: new Date("2026-04-21T10:00:00.000Z"),
          status: "active",
        },
        {
          id: assistantInferredClaimId,
          userId,
          subjectNodeId: personNodeId,
          objectValue: "is vegetarian",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel might be vegetarian.",
          sourceId,
          scope: "personal",
          assertedByKind: "assistant_inferred",
          statedAt: new Date("2026-04-22T10:00:00.000Z"),
          status: "active",
        },
        {
          id: supersededClaimId,
          userId,
          subjectNodeId: personNodeId,
          objectValue: "in_progress",
          predicate: "HAS_STATUS",
          statement: "Marcel is in progress on the claims layer.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-19T10:00:00.000Z"),
          status: "superseded",
        },
        {
          id: systemRelClaimId,
          userId,
          subjectNodeId: personNodeId,
          objectNodeId: projectNodeId,
          predicate: "RELATED_TO",
          statement: "Marcel is associated with the Claims Layer.",
          sourceId,
          scope: "personal",
          assertedByKind: "system",
          statedAt: new Date("2026-04-23T10:00:00.000Z"),
          status: "active",
        },
        {
          id: referenceClaimId,
          userId,
          subjectNodeId: personNodeId,
          objectValue: "stoic philosophy",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel is interested in stoic philosophy.",
          sourceId: referenceSourceId,
          scope: "reference",
          assertedByKind: "document_author",
          statedAt: new Date("2026-04-24T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const { runProfileSynthesis } = await import("./profile-synthesis");
      const { setLogSink } = await import("~/lib/observability/log");
      const captured: Array<Record<string, unknown>> = [];
      setLogSink((event) => captured.push(event));
      let result;
      try {
        result = await runProfileSynthesis({
          userId,
          nodeId: personNodeId,
        });
        const synthesizedEvents = captured.filter(
          (e) => e["event"] === "profile.synthesized",
        );
        expect(synthesizedEvents).toHaveLength(1);
        expect(synthesizedEvents[0]).toMatchObject({
          event: "profile.synthesized",
          userId,
          nodeId: personNodeId,
        });
        expect(typeof synthesizedEvents[0]?.["contentHash"]).toBe("string");
        expect(typeof synthesizedEvents[0]?.["inputClaimCount"]).toBe("number");
      } finally {
        setLogSink();
      }

      expect(result.status).toBe("synthesized");
      expect(llmCallCount).toBe(1);
      expect(lastSchemaName).toBe("ProfileSynthesisOutput");

      // Trusted claims must be in the prompt.
      expect(lastPrompt).toContain("HAS_PREFERENCE=prefers concise communication");
      expect(lastPrompt).toContain("HAS_GOAL=ship the claims layer in Q2");
      expect(lastPrompt).toContain("RELATED_TO -> Claims Layer");
      expect(lastPrompt).toContain('aliases: "Marc"');
      expect(lastPrompt).toContain("Stale prior description.");
      // Reference, assistant_inferred, and superseded claims must be excluded.
      expect(lastPrompt).not.toContain("vegetarian");
      expect(lastPrompt).not.toContain("stoic philosophy");
      expect(lastPrompt).not.toContain("in_progress");

      const persisted = await client.query<{
        description: string | null;
        additional_data: { profileSynthesisHash?: string } | null;
      }>(
        `SELECT "description", "additional_data" FROM "node_metadata" WHERE "node_id" = $1`,
        [personNodeId],
      );
      const row = persisted.rows[0];
      expect(row?.description).toContain("senior engineer");
      const hash = row?.additional_data?.profileSynthesisHash;
      expect(typeof hash).toBe("string");
      expect((hash ?? "").length).toBeGreaterThan(16);

      // Re-running with unchanged inputs is a cache hit — no LLM call.
      const second = await runProfileSynthesis({
        userId,
        nodeId: personNodeId,
      });
      expect(second.status).toBe("skipped_cache_hit");
      expect(llmCallCount).toBe(1);
      expect(second.hash).toBe(hash);

      // Replace each trusted claim with a fresh row that has a NEW id and
      // statedAt but identical (predicate, objectValue/objectNodeId,
      // assertedByKind, status). The semantic fingerprint is unchanged, so
      // the third run must also cache-hit. This is the optimization that
      // matters: re-ingesting the same fact in a new message must not burn
      // an LLM call.
      await database
        .delete(schema.claims)
        .where(eq(schema.claims.userId, userId));
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "prefers concise communication",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel really prefers concise communication.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-25T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "ship the claims layer in Q2",
          predicate: "HAS_GOAL",
          statement: "Marcel committed to shipping the claims layer in Q2.",
          sourceId,
          scope: "personal",
          assertedByKind: "user_confirmed",
          statedAt: new Date("2026-04-25T11:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectNodeId: projectNodeId,
          predicate: "RELATED_TO",
          statement: "Marcel keeps coming back to the Claims Layer.",
          sourceId,
          scope: "personal",
          assertedByKind: "system",
          statedAt: new Date("2026-04-25T12:00:00.000Z"),
          status: "active",
        },
      ]);

      const third = await runProfileSynthesis({
        userId,
        nodeId: personNodeId,
      });
      expect(third.status).toBe("skipped_cache_hit");
      expect(llmCallCount).toBe(1);
      expect(third.hash).toBe(hash);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("../ai");
      vi.resetModules();
      await client.end();
    }
  });

  it("short-circuits without an LLM call when the node has only reference-scope support", async () => {
    const userId = "user_profile_reference";
    const referenceNodeId = newTypeId("node");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    let llmCallCount = 0;

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("../ai", () => ({
      performStructuredAnalysis: async () => {
        llmCallCount += 1;
        return { description: "should not be called" };
      },
    }));

    try {
      await createProfileSynthesisTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [referenceNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description") VALUES
          ($1, $2, 'Marcus Aurelius', 'marcus aurelius', 'Roman emperor and stoic philosopher.')`,
        [newTypeId("node_metadata"), referenceNodeId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status") VALUES
          ($1, $2, 'document', 'meditations', 'reference', 'completed')`,
        [referenceSourceId, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES ($1, $2, $3)`,
        [newTypeId("source_link"), referenceSourceId, referenceNodeId],
      );

      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: referenceNodeId,
          objectValue: "Roman Emperor",
          predicate: "HAS_STATUS",
          statement: "Marcus Aurelius was a Roman Emperor.",
          sourceId: referenceSourceId,
          scope: "reference",
          assertedByKind: "document_author",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const { runProfileSynthesis } = await import("./profile-synthesis");

      const result = await runProfileSynthesis({
        userId,
        nodeId: referenceNodeId,
      });

      expect(result.status).toBe("skipped_reference_only");
      expect(llmCallCount).toBe(0);

      // Description is untouched.
      const persisted = await client.query<{
        description: string | null;
        additional_data: { profileSynthesisHash?: string } | null;
      }>(
        `SELECT "description", "additional_data" FROM "node_metadata" WHERE "node_id" = $1`,
        [referenceNodeId],
      );
      expect(persisted.rows[0]?.description).toBe(
        "Roman emperor and stoic philosopher.",
      );
      expect(persisted.rows[0]?.additional_data?.profileSynthesisHash).toBeUndefined();
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("../ai");
      vi.resetModules();
      await client.end();
    }
  });
});
