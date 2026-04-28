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
// Lower the embedding threshold so a near-aligned 1024-d test vector still
// clears the gate; the production default (0.78) needs higher fidelity than
// the synthetic vectors used here.
process.env["IDENTITY_EMBEDDING_THRESHOLD"] ??= "0.5";
process.env["IDENTITY_PROFILE_COMPAT_THRESHOLD"] ??= "0.4";

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

interface MergeProposalLog {
  event: "identity.merge_proposal";
  userId: string;
  candidateNodeId: string;
  proposedTargetNodeId: string;
  signal: string;
  confidence: number;
}

function captureMergeProposalLogs(): {
  logs: MergeProposalLog[];
  restore: () => void;
} {
  const logs: MergeProposalLog[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === "string") {
      try {
        const parsed: unknown = JSON.parse(first);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          (parsed as { event?: unknown }).event === "identity.merge_proposal"
        ) {
          logs.push(parsed as MergeProposalLog);
        }
      } catch {
        // not JSON; ignore
      }
    }
  };
  return {
    logs,
    restore: () => {
      console.info = original;
    },
  };
}

describeIfServer("runIdentityReeval", () => {
  const dbName = `memory_identity_reeval_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(`CREATE EXTENSION IF NOT EXISTS "vector"`);
    await createIdentityReevalTables(client);
    await client.end();
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

  async function createIdentityReevalTables(client: Client): Promise<void> {
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
      CREATE TABLE IF NOT EXISTS "node_embeddings" (
        "id" text PRIMARY KEY NOT NULL,
        "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
        "embedding" vector(1024) NOT NULL,
        "model_name" varchar(100) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
  }

  // Two near-aligned unit vectors: vecA points along axis 0, vecB shares 99% of
  // its mass with axis 0 plus a small axis-1 component, giving cosine ~0.99 —
  // well above the lowered IDENTITY_EMBEDDING_THRESHOLD.
  const vecA = [1, ...Array.from({ length: 1023 }, () => 0)];
  const vecB = [
    Math.cos(0.05),
    Math.sin(0.05),
    ...Array.from({ length: 1022 }, () => 0),
  ];
  // vecC is orthogonal to vecA — used for nodes that should NOT match.
  const vecC = [
    0,
    1,
    ...Array.from({ length: 1022 }, () => 0),
  ];

  async function resetState(client: Client): Promise<void> {
    await client.query(`
      TRUNCATE
        "node_embeddings",
        "aliases",
        "claims",
        "source_links",
        "sources",
        "node_metadata",
        "nodes",
        "users"
      RESTART IDENTITY CASCADE
    `);
  }

  it("excludes self-match: a node that finds only itself across all signals produces no merge proposal", async () => {
    const userId = "user_self_match";
    const personId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    const captured = captureMergeProposalLogs();
    try {
      await resetState(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [personId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'Marcel', 'marcel')`,
        [newTypeId("node_metadata"), personId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES ($1, $2, 'conversation_message', 'msg', 'personal')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES ($1, $2, $3)`,
        [newTypeId("source_link"), sourceId, personId],
      );
      await client.query(
        `INSERT INTO "node_embeddings" ("id", "node_id", "embedding", "model_name") VALUES ($1, $2, $3::vector, 'test')`,
        [newTypeId("node_embedding"), personId, JSON.stringify(vecA)],
      );

      const { runIdentityReeval } = await import("./identity-reeval");
      const result = await runIdentityReeval({ userId, nodeId: personId });

      // The candidate node is the only thing in its embedding-similar set;
      // it's filtered out via `excludeNodeIds`, so no signal fires.
      expect(result.status).toBe("no_proposal");
      expect(captured.logs).toHaveLength(0);
    } finally {
      captured.restore();
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("emits a merge proposal when two same-type personal nodes overlap on user/user_confirmed claims", async () => {
    const userId = "user_positive_proposal";
    const candidateId = newTypeId("node");
    const targetId = newTypeId("node");
    const employerId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    const captured = captureMergeProposalLogs();
    try {
      await resetState(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $4, 'Person'),
          ($2, $4, 'Person'),
          ($3, $4, 'Object')`,
        [candidateId, targetId, employerId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
          ($1, $4, 'Sam Smith',  'sam smith'),
          ($2, $5, 'Samuel S.',  'samuel s'),
          ($3, $6, 'Acme',       'acme')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          candidateId,
          targetId,
          employerId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES ($1, $2, 'conversation_message', 'msg', 'personal')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES
          ($1, $4, $5),
          ($2, $4, $6),
          ($3, $4, $7)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          newTypeId("source_link"),
          sourceId,
          candidateId,
          targetId,
          employerId,
        ],
      );
      // Embeddings: candidate ~ vecA, target ~ vecB (close), so cosine sim
      // crosses the threshold.
      await client.query(
        `INSERT INTO "node_embeddings" ("id", "node_id", "embedding", "model_name") VALUES
          ($1, $4, $5::vector, 'test'),
          ($2, $6, $7::vector, 'test'),
          ($3, $8, $9::vector, 'test')`,
        [
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          candidateId,
          JSON.stringify(vecA),
          targetId,
          JSON.stringify(vecB),
          employerId,
          JSON.stringify(vecC),
        ],
      );
      // Both nodes share the same user-asserted relationship claim
      // (WORKED_AT -> Acme): perfect profile-compat overlap.
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: candidateId,
          objectNodeId: employerId,
          predicate: "RELATED_TO",
          statement: "Sam Smith is associated with Acme.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: targetId,
          objectNodeId: employerId,
          predicate: "RELATED_TO",
          statement: "Samuel S. is associated with Acme.",
          sourceId,
          scope: "personal",
          assertedByKind: "user_confirmed",
          statedAt: new Date("2026-04-21T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const { runIdentityReeval } = await import("./identity-reeval");
      const result = await runIdentityReeval({ userId, nodeId: candidateId });

      expect(result.status).toBe("merge_proposed");
      expect(result.proposedTargetNodeId).toBe(targetId);
      expect(captured.logs).toHaveLength(1);
      const logEntry = captured.logs[0];
      expect(logEntry?.event).toBe("identity.merge_proposal");
      expect(logEntry?.candidateNodeId).toBe(candidateId);
      expect(logEntry?.proposedTargetNodeId).toBe(targetId);
      expect(logEntry?.signal).toBe("profile_compat");
      expect(logEntry?.userId).toBe(userId);
    } finally {
      captured.restore();
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("does not propose a merge when overlap is only via assistant_inferred claims", async () => {
    const userId = "user_assistant_inferred_only";
    const candidateId = newTypeId("node");
    const targetId = newTypeId("node");
    const employerId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    const captured = captureMergeProposalLogs();
    try {
      await resetState(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $4, 'Person'),
          ($2, $4, 'Person'),
          ($3, $4, 'Object')`,
        [candidateId, targetId, employerId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
          ($1, $4, 'Sam Smith',  'sam smith'),
          ($2, $5, 'Samuel S.',  'samuel s'),
          ($3, $6, 'Acme',       'acme')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          candidateId,
          targetId,
          employerId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES ($1, $2, 'conversation_message', 'msg', 'personal')`,
        [sourceId, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES
          ($1, $4, $5),
          ($2, $4, $6),
          ($3, $4, $7)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          newTypeId("source_link"),
          sourceId,
          candidateId,
          targetId,
          employerId,
        ],
      );
      await client.query(
        `INSERT INTO "node_embeddings" ("id", "node_id", "embedding", "model_name") VALUES
          ($1, $4, $5::vector, 'test'),
          ($2, $6, $7::vector, 'test'),
          ($3, $8, $9::vector, 'test')`,
        [
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          candidateId,
          JSON.stringify(vecA),
          targetId,
          JSON.stringify(vecB),
          employerId,
          JSON.stringify(vecC),
        ],
      );
      // Both nodes share a relationship claim, but it's `assistant_inferred`
      // on the target — that kind is filtered out of the profile-compat
      // calculation, so overlap ends up zero.
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: candidateId,
          objectNodeId: employerId,
          predicate: "RELATED_TO",
          statement: "Sam Smith is associated with Acme.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: targetId,
          objectNodeId: employerId,
          predicate: "RELATED_TO",
          statement: "Samuel S. probably associated with Acme.",
          sourceId,
          scope: "personal",
          assertedByKind: "assistant_inferred",
          statedAt: new Date("2026-04-21T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const { runIdentityReeval } = await import("./identity-reeval");
      const result = await runIdentityReeval({ userId, nodeId: candidateId });

      expect(result.status).toBe("no_proposal");
      expect(captured.logs).toHaveLength(0);
    } finally {
      captured.restore();
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("refuses a cross-scope match: a personal node embedding-similar to a reference node does not produce a proposal", async () => {
    const userId = "user_cross_scope";
    const personalId = newTypeId("node");
    const referenceId = newTypeId("node");
    const personalSrc = newTypeId("source");
    const referenceSrc = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    const captured = captureMergeProposalLogs();
    try {
      await resetState(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $3, 'Concept'),
          ($2, $3, 'Concept')`,
        [personalId, referenceId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES
          ($1, $3, 'Stoicism — my notes', 'stoicism — my notes'),
          ($2, $4, 'Stoicism (book)',     'stoicism book')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personalId,
          referenceId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES
          ($1, $3, 'conversation_message', 'msg', 'personal'),
          ($2, $3, 'document',              'meditations', 'reference')`,
        [personalSrc, referenceSrc, userId],
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES
          ($1, $3, $5),
          ($2, $4, $6)`,
        [
          newTypeId("source_link"),
          newTypeId("source_link"),
          personalSrc,
          referenceSrc,
          personalId,
          referenceId,
        ],
      );
      // Both nodes have near-identical embeddings — embedding-only similarity
      // would match — but `findSimilarNodes` is scope-bounded by default, and
      // the reeval candidate scope (`personal`) excludes the reference node.
      await client.query(
        `INSERT INTO "node_embeddings" ("id", "node_id", "embedding", "model_name") VALUES
          ($1, $3, $4::vector, 'test'),
          ($2, $5, $6::vector, 'test')`,
        [
          newTypeId("node_embedding"),
          newTypeId("node_embedding"),
          personalId,
          JSON.stringify(vecA),
          referenceId,
          JSON.stringify(vecB),
        ],
      );
      // Give the personal node a trustworthy supporting claim so signal 4
      // would have something to compare. The cross-scope refusal must still
      // hold because the reference node is the only viable target.
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personalId,
          objectValue: "stoic principles in daily life",
          predicate: "HAS_PREFERENCE",
          statement: "User practices stoic principles.",
          sourceId: personalSrc,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const { runIdentityReeval } = await import("./identity-reeval");
      const result = await runIdentityReeval({ userId, nodeId: personalId });

      expect(result.status).toBe("no_proposal");
      expect(captured.logs).toHaveLength(0);
    } finally {
      captured.restore();
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
