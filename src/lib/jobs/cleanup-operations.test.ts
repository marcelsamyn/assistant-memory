/**
 * Per-operation regression suite for the cleanup vocabulary.
 *
 * Mirrors the DB-integration style used in `dedup-sweep.test.ts` and
 * `lifecycle.test.ts`: real Postgres on the non-default test port, hand-rolled
 * DDL (no migrator, no pgvector), `createClaim` reaches `useDatabase()` which
 * we mock so it routes back to the test DB. Embeddings + atlas-invalidation
 * are mocked to no-ops so we don't pull in the worker stack.
 */
import { TemporaryIdMapper } from "../temporary-id-mapper";
import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import * as schema from "~/db/schema";
import type { GraphNode } from "~/lib/jobs/cleanup-graph";
import { newTypeId, type TypeId } from "~/types/typeid";

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

type TestDb = NodePgDatabase<typeof schema>;

async function createTables(client: Client): Promise<void> {
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
      UNIQUE ("node_id")
    );
    CREATE TABLE IF NOT EXISTS "sources" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "type" varchar(50) NOT NULL,
      "external_id" text NOT NULL,
      "scope" varchar(16) DEFAULT 'personal' NOT NULL,
      "status" varchar(20) DEFAULT 'completed',
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
        CHECK (num_nonnulls("object_node_id", "object_value") = 1)
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
  `);
}

async function seedUserAndNodes(
  client: Client,
  userId: string,
  nodeSpecs: Array<{
    id: TypeId<"node">;
    nodeType: string;
    label: string;
  }>,
): Promise<void> {
  await client.query(
    `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
    [userId],
  );
  for (const spec of nodeSpecs) {
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, $3)`,
      [spec.id, userId, spec.nodeType],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
       VALUES ($1, $2, $3, lower($3))`,
      [newTypeId("node_metadata"), spec.id, spec.label],
    );
  }
}

async function seedSource(
  client: Client,
  args: {
    sourceId: TypeId<"source">;
    userId: string;
    type: string;
    externalId: string;
    scope: "personal" | "reference";
  },
): Promise<void> {
  await client.query(
    `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
     VALUES ($1, $2, $3, $4, $5, 'completed')`,
    [args.sourceId, args.userId, args.type, args.externalId, args.scope],
  );
}

interface InsertClaimArgs {
  id: TypeId<"claim">;
  userId: string;
  subjectNodeId: TypeId<"node">;
  predicate: string;
  statement: string;
  sourceId: TypeId<"source">;
  scope?: "personal" | "reference";
  assertedByKind?: string;
  objectNodeId?: TypeId<"node"> | null;
  objectValue?: string | null;
  assertedByNodeId?: TypeId<"node"> | null;
  status?: string;
  statedAt?: Date;
}

async function seedClaim(client: Client, args: InsertClaimArgs): Promise<void> {
  await client.query(
    `INSERT INTO "claims" (
       "id", "user_id", "subject_node_id", "object_node_id", "object_value",
       "predicate", "statement", "source_id", "scope", "asserted_by_kind",
       "asserted_by_node_id", "stated_at", "status"
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      args.id,
      args.userId,
      args.subjectNodeId,
      args.objectNodeId ?? null,
      args.objectValue ?? null,
      args.predicate,
      args.statement,
      args.sourceId,
      args.scope ?? "personal",
      args.assertedByKind ?? "user",
      args.assertedByNodeId ?? null,
      args.statedAt ?? new Date(),
      args.status ?? "active",
    ],
  );
}

function buildMapper(
  graphNodes: Array<GraphNode & { tempId: string }>,
): TemporaryIdMapper<GraphNode, string> {
  const mapper = new TemporaryIdMapper<GraphNode, string>(
    (item) => (item as GraphNode & { tempId: string }).tempId,
  );
  // Pass nodes that already carry their tempId; the generator simply reads it.
  mapper.mapItems(graphNodes);
  return mapper;
}

describeIfServer("cleanup operation helpers", () => {
  const dbName = `memory_cleanup_ops_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  let database: TestDb;
  let rootClient: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    rootClient = new Client({ connectionString: dsnFor(dbName) });
    await rootClient.connect();
    database = drizzle(rootClient, { schema, casing: "snake_case" });
    await createTables(rootClient);

    // The dispatcher's helpers call `createClaim` which calls
    // `useDatabase()` directly. Reroute to our test DB and stub the
    // embedding + atlas-invalidation modules.
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    // Return no embedding so `insertClaimEmbedding` short-circuits and we
    // don't need a pgvector extension in the test DB.
    vi.doMock("~/lib/embeddings", () => ({
      generateEmbeddings: async () => ({
        data: [{}],
        usage: { total_tokens: 0 },
      }),
    }));
    vi.doMock("~/lib/jobs/atlas-invalidation", () => ({
      maybeEnqueueAtlasInvalidation: async () => false,
    }));
  });

  afterAll(async () => {
    vi.doUnmock("~/utils/db");
    vi.doUnmock("~/lib/embeddings");
    vi.doUnmock("~/lib/jobs/atlas-invalidation");
    vi.resetModules();
    await rootClient.end();

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

  afterEach(async () => {
    // Truncate user-scoped data so tests don't bleed.
    await rootClient.query(
      `TRUNCATE "aliases", "claims", "source_links",
              "node_metadata", "nodes", "sources", "users" CASCADE`,
    );
  });

  it("retract_claim flips status and runs lifecycle", async () => {
    const userId = "user_retract";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "alice" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "manual",
      externalId: "manual:user_retract",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Alice is active.",
      sourceId,
      objectValue: "active",
      assertedByKind: "assistant_inferred",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const { setLogSink } = await import("~/lib/observability/log");
    const captured: Array<Record<string, unknown>> = [];
    setLogSink((event) => captured.push(event));
    try {
      const mapper = buildMapper([]);
      const result = await applyCleanupOperations(
        database,
        userId,
        [{ kind: "retract_claim", claimId, reason: "dup" }],
        mapper,
      );
      expect(result.applied).toBe(1);
      expect(result.errors).toHaveLength(0);

      const after = await rootClient.query<{ status: string }>(
        `SELECT "status" FROM "claims" WHERE "id" = $1`,
        [claimId],
      );
      expect(after.rows[0]?.status).toBe("retracted");

      const retractedEvents = captured.filter(
        (e) => e["event"] === "claim.retracted",
      );
      expect(retractedEvents.length).toBeGreaterThan(0);
      expect(retractedEvents[0]).toMatchObject({
        event: "claim.retracted",
        claimId,
        userId,
        reason: "dup",
      });
    } finally {
      setLogSink();
    }
  });

  it("retract_claim refuses migrated/user-attributed claims", async () => {
    const userId = "user_retract_legacy_refused";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Concept", label: "legacy topic" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "legacy_migration",
      externalId: `legacy_migration:${userId}`,
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "RELATED_TO",
      statement: "Legacy topic related to another migrated concept.",
      sourceId,
      objectValue: "another migrated concept",
      assertedByKind: "user",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "retract_claim",
          claimId,
          reason: "not corroborated by bundle",
        },
      ],
      buildMapper([]),
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("retract_claim");
    expect(result.errors[0]?.message).toMatch(/refused for user claim/);

    const after = await rootClient.query<{ status: string }>(
      `SELECT "status" FROM "claims" WHERE "id" = $1`,
      [claimId],
    );
    expect(after.rows[0]?.status).toBe("active");
  });

  it("contradict_claim sets contradicted_by_claim_id and status", async () => {
    const userId = "user_contradict";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");
    const citingId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "bob" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "manual",
      externalId: "manual:user_contradict",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Bob is gone.",
      sourceId,
      objectValue: "gone",
    });
    await seedClaim(rootClient, {
      id: citingId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Bob is here.",
      sourceId,
      objectValue: "here",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const { setLogSink } = await import("~/lib/observability/log");
    const captured: Array<Record<string, unknown>> = [];
    setLogSink((event) => captured.push(event));
    try {
      const result = await applyCleanupOperations(
        database,
        userId,
        [
          {
            kind: "contradict_claim",
            claimId,
            contradictedByClaimId: citingId,
            reason: "user said the opposite",
          },
        ],
        buildMapper([]),
      );
      expect(result.applied).toBe(1);

      const after = await rootClient.query<{
        status: string;
        contradicted_by_claim_id: string | null;
      }>(
        `SELECT "status", "contradicted_by_claim_id" FROM "claims" WHERE "id" = $1`,
        [claimId],
      );
      expect(after.rows[0]?.status).toBe("contradicted");
      expect(after.rows[0]?.contradicted_by_claim_id).toBe(citingId);

      const contradictedEvents = captured.filter(
        (e) => e["event"] === "claim.contradicted",
      );
      expect(contradictedEvents.length).toBeGreaterThan(0);
      expect(contradictedEvents[0]).toMatchObject({
        event: "claim.contradicted",
        claimId,
        contradictedByClaimId: citingId,
        reason: "user said the opposite",
      });
    } finally {
      setLogSink();
    }
  });

  it("contradict_claim refuses assistant-inferred citations", async () => {
    const userId = "user_contradict_inferred_citation";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");
    const citingId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "bob" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "conversation_message",
      externalId: "msg:user_contradict_inferred_citation",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Bob is gone.",
      sourceId,
      objectValue: "gone",
      assertedByKind: "user",
    });
    await seedClaim(rootClient, {
      id: citingId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Bob is here.",
      sourceId,
      objectValue: "here",
      assertedByKind: "assistant_inferred",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "contradict_claim",
          claimId,
          contradictedByClaimId: citingId,
          reason: "assistant guessed the opposite",
        },
      ],
      buildMapper([]),
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("contradict_claim");
    expect(result.errors[0]?.message).toMatch(/source-backed provenance/);

    const after = await rootClient.query<{ status: string }>(
      `SELECT "status" FROM "claims" WHERE "id" = $1`,
      [claimId],
    );
    expect(after.rows[0]?.status).toBe("active");
  });

  it("contradict_claim refuses cross-scope citations", async () => {
    const userId = "user_contradict_cross_scope";
    const subjectId = newTypeId("node");
    const personalSourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");
    const claimId = newTypeId("claim");
    const citingId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Concept", label: "topic" },
    ]);
    await seedSource(rootClient, {
      sourceId: personalSourceId,
      userId,
      type: "conversation_message",
      externalId: "msg:user_contradict_cross_scope",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: referenceSourceId,
      userId,
      type: "document",
      externalId: "doc:user_contradict_cross_scope",
      scope: "reference",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Topic is personal.",
      sourceId: personalSourceId,
      objectValue: "personal",
      scope: "personal",
      assertedByKind: "user",
    });
    await seedClaim(rootClient, {
      id: citingId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Topic is only reference material.",
      sourceId: referenceSourceId,
      objectValue: "reference",
      scope: "reference",
      assertedByKind: "document_author",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "contradict_claim",
          claimId,
          contradictedByClaimId: citingId,
          reason: "reference doc said something different",
        },
      ],
      buildMapper([]),
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("contradict_claim");
    expect(result.errors[0]?.message).toMatch(/scope mismatch/);

    const after = await rootClient.query<{ status: string }>(
      `SELECT "status" FROM "claims" WHERE "id" = $1`,
      [claimId],
    );
    expect(after.rows[0]?.status).toBe("active");
  });

  it("delete_node deletes only evidence-free orphan nodes", async () => {
    const userId = "user_delete_orphan";
    const nodeId = newTypeId("node");
    await seedUserAndNodes(rootClient, userId, [
      { id: nodeId, nodeType: "Concept", label: "empty shell" },
    ]);

    const graphNode: GraphNode & { tempId: string } = {
      id: nodeId,
      tempId: "temp_node_1",
      label: "empty shell",
      description: "",
      type: "Concept",
    };

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [{ kind: "delete_node", tempId: "temp_node_1" }],
      buildMapper([graphNode]),
    );

    expect(result.applied).toBe(1);
    expect(result.errors).toHaveLength(0);

    const after = await rootClient.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "nodes" WHERE "id" = $1`,
      [nodeId],
    );
    expect(after.rows[0]?.count).toBe("0");
  });

  it("delete_node refuses nodes that still have claims", async () => {
    const userId = "user_delete_with_claims_refused";
    const nodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");
    await seedUserAndNodes(rootClient, userId, [
      { id: nodeId, nodeType: "Concept", label: "claimed topic" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "legacy_migration",
      externalId: `legacy_migration:${userId}`,
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: nodeId,
      predicate: "RELATED_TO",
      statement: "Claimed topic related to imported memory.",
      sourceId,
      objectValue: "imported memory",
      assertedByKind: "user",
    });

    const graphNode: GraphNode & { tempId: string } = {
      id: nodeId,
      tempId: "temp_node_1",
      label: "claimed topic",
      description: "",
      type: "Concept",
    };

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [{ kind: "delete_node", tempId: "temp_node_1" }],
      buildMapper([graphNode]),
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("delete_node");
    expect(result.errors[0]?.message).toMatch(/still has claims=1/);

    const after = await rootClient.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "nodes" WHERE "id" = $1`,
      [nodeId],
    );
    expect(after.rows[0]?.count).toBe("1");
  });

  it("delete_node refuses nodes used as participant provenance", async () => {
    const userId = "user_delete_speaker_refused";
    const speakerId = newTypeId("node");
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const claimId = newTypeId("claim");
    await seedUserAndNodes(rootClient, userId, [
      { id: speakerId, nodeType: "Person", label: "speaker" },
      { id: subjectId, nodeType: "Concept", label: "meeting topic" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "conversation_message",
      externalId: "msg:speaker",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: claimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "The meeting topic is ready.",
      sourceId,
      objectValue: "ready",
      assertedByKind: "participant",
      assertedByNodeId: speakerId,
    });

    const graphNode: GraphNode & { tempId: string } = {
      id: speakerId,
      tempId: "temp_node_1",
      label: "speaker",
      description: "",
      type: "Person",
    };

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [{ kind: "delete_node", tempId: "temp_node_1" }],
      buildMapper([graphNode]),
    );

    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/still has claims=1/);

    const after = await rootClient.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "nodes" WHERE "id" = $1`,
      [speakerId],
    );
    expect(after.rows[0]?.count).toBe("1");
  });

  it("add_claim stamps system kind and inherits scope from source claim", async () => {
    const userId = "user_addclaim";
    const subjectId = newTypeId("node");
    const objectId = newTypeId("node");
    const refSourceId = newTypeId("source");
    const refClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "carol" },
      { id: objectId, nodeType: "Concept", label: "physics" },
    ]);
    await seedSource(rootClient, {
      sourceId: refSourceId,
      userId,
      type: "document",
      externalId: "doc:ref",
      scope: "reference",
    });
    await seedClaim(rootClient, {
      id: refClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "RELATED_TO",
      statement: "Carol related to physics (book).",
      sourceId: refSourceId,
      objectNodeId: objectId,
      scope: "reference",
      assertedByKind: "document_author",
    });

    const subjectGraphNode: GraphNode = {
      id: subjectId,
      label: "carol",
      description: "",
      type: "Person",
    };
    const objectGraphNode: GraphNode = {
      id: objectId,
      label: "physics",
      description: "",
      type: "Concept",
    };
    const mapper = buildMapper([
      { ...subjectGraphNode, tempId: "temp_node_1" },
      { ...objectGraphNode, tempId: "temp_node_2" },
    ]);

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const { setLogSink } = await import("~/lib/observability/log");
    const captured: Array<Record<string, unknown>> = [];
    setLogSink((event) => captured.push(event));
    let result;
    try {
      result = await applyCleanupOperations(
        database,
        userId,
        [
          {
            kind: "add_claim",
            subjectTempId: "temp_node_1",
            objectTempId: "temp_node_2",
            predicate: "RELATED_TO",
            statement: "Carol relates to physics.",
            sourceClaimId: refClaimId,
          },
        ],
        mapper,
      );
      const insertedEvents = captured.filter(
        (e) => e["event"] === "claim.inserted",
      );
      expect(insertedEvents).toHaveLength(1);
      expect(insertedEvents[0]).toMatchObject({
        event: "claim.inserted",
        userId,
        predicate: "RELATED_TO",
        kind: "system",
        scope: "reference",
        subjectNodeId: subjectId,
      });
    } finally {
      setLogSink();
    }
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);

    const inserted = await rootClient.query<{
      asserted_by_kind: string;
      scope: string;
      source_id: string;
    }>(
      `SELECT "asserted_by_kind", "scope", "source_id" FROM "claims"
       WHERE "user_id" = $1 AND "id" <> $2`,
      [userId, refClaimId],
    );
    expect(inserted.rows).toHaveLength(1);
    expect(inserted.rows[0]).toMatchObject({
      asserted_by_kind: "system",
      scope: "reference",
      source_id: refSourceId,
    });
  });

  it("add_alias and remove_alias use the alias helpers", async () => {
    const userId = "user_alias";
    const nodeId = newTypeId("node");

    await seedUserAndNodes(rootClient, userId, [
      { id: nodeId, nodeType: "Person", label: "danielle" },
    ]);

    const mapper = buildMapper([
      {
        id: nodeId,
        label: "danielle",
        description: "",
        type: "Person",
        tempId: "temp_node_1",
      },
    ]);

    const { applyCleanupOperations } = await import("./cleanup-operations");

    const addResult = await applyCleanupOperations(
      database,
      userId,
      [{ kind: "add_alias", nodeTempId: "temp_node_1", aliasText: "Dani" }],
      mapper,
    );
    expect(addResult.errors).toHaveLength(0);
    expect(addResult.applied).toBe(1);

    const afterAdd = await rootClient.query<{ alias_text: string }>(
      `SELECT "alias_text" FROM "aliases" WHERE "user_id" = $1`,
      [userId],
    );
    expect(afterAdd.rows.map((r) => r.alias_text)).toEqual(["Dani"]);

    const removeResult = await applyCleanupOperations(
      database,
      userId,
      [{ kind: "remove_alias", nodeTempId: "temp_node_1", aliasText: "Dani" }],
      mapper,
    );
    expect(removeResult.applied).toBe(1);

    const afterRemove = await rootClient.query<{ alias_text: string }>(
      `SELECT "alias_text" FROM "aliases" WHERE "user_id" = $1`,
      [userId],
    );
    expect(afterRemove.rows).toHaveLength(0);
  });

  it("merge_nodes happy path within the same scope", async () => {
    const userId = "user_merge_ok";
    const keepId = newTypeId("node");
    const removeId = newTypeId("node");
    const sourceId = newTypeId("source");

    await seedUserAndNodes(rootClient, userId, [
      { id: keepId, nodeType: "Person", label: "elliot" },
      { id: removeId, nodeType: "Person", label: "elliot" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "manual",
      externalId: "manual:user_merge_ok",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: newTypeId("claim"),
      userId,
      subjectNodeId: keepId,
      predicate: "HAS_PREFERENCE",
      statement: "Elliot likes coffee.",
      sourceId,
      objectValue: "coffee",
    });
    await seedClaim(rootClient, {
      id: newTypeId("claim"),
      userId,
      subjectNodeId: removeId,
      predicate: "HAS_PREFERENCE",
      statement: "Elliot likes tea.",
      sourceId,
      objectValue: "tea",
    });

    const mapper = buildMapper([
      {
        id: keepId,
        label: "elliot",
        description: "",
        type: "Person",
        tempId: "temp_node_1",
      },
      {
        id: removeId,
        label: "elliot",
        description: "",
        type: "Person",
        tempId: "temp_node_2",
      },
    ]);

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "merge_nodes",
          keepTempId: "temp_node_1",
          removeTempIds: ["temp_node_2"],
        },
      ],
      mapper,
    );
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);

    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1`,
      [userId],
    );
    expect(remaining.rows.map((r) => r.id)).toEqual([keepId]);
  });

  it("merge_nodes refuses cross-scope candidates with CrossScopeMergeError", async () => {
    const userId = "user_merge_xscope";
    const personalId = newTypeId("node");
    const referenceId = newTypeId("node");
    const personalSource = newTypeId("source");
    const referenceSource = newTypeId("source");

    await seedUserAndNodes(rootClient, userId, [
      { id: personalId, nodeType: "Person", label: "marie" },
      { id: referenceId, nodeType: "Person", label: "marie" },
    ]);
    await seedSource(rootClient, {
      sourceId: personalSource,
      userId,
      type: "manual",
      externalId: "manual:user_merge_xscope",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: referenceSource,
      userId,
      type: "document",
      externalId: "doc:user_merge_xscope",
      scope: "reference",
    });
    await seedClaim(rootClient, {
      id: newTypeId("claim"),
      userId,
      subjectNodeId: personalId,
      predicate: "HAS_PREFERENCE",
      statement: "User admires Marie.",
      sourceId: personalSource,
      scope: "personal",
      objectValue: "admires",
    });
    await seedClaim(rootClient, {
      id: newTypeId("claim"),
      userId,
      subjectNodeId: referenceId,
      predicate: "RELATED_TO",
      statement: "Marie was a physicist.",
      sourceId: referenceSource,
      scope: "reference",
      assertedByKind: "document_author",
      objectValue: "physicist",
    });

    const mapper = buildMapper([
      {
        id: personalId,
        label: "marie",
        description: "",
        type: "Person",
        tempId: "temp_node_1",
      },
      {
        id: referenceId,
        label: "marie",
        description: "",
        type: "Person",
        tempId: "temp_node_2",
      },
    ]);

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "merge_nodes",
          keepTempId: "temp_node_1",
          removeTempIds: ["temp_node_2"],
        },
      ],
      mapper,
    );
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("merge_nodes");
    expect(result.errors[0]?.message).toMatch(/Cross-scope merge refused/);

    const remaining = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "nodes" WHERE "user_id" = $1 ORDER BY "id"`,
      [userId],
    );
    expect(remaining.rows.map((r) => r.id).sort()).toEqual(
      [personalId, referenceId].sort(),
    );
  });

  it("promote_assertion on a single-valued predicate supersedes the original", async () => {
    const userId = "user_promote_single";
    const subjectId = newTypeId("node");
    const inferredSource = newTypeId("source");
    const corroboratingSource = newTypeId("source");
    const inferredClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Concept", label: "memory_refactor" },
    ]);
    await seedSource(rootClient, {
      sourceId: inferredSource,
      userId,
      type: "conversation_message",
      externalId: "msg:inferred",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: corroboratingSource,
      userId,
      type: "conversation_message",
      externalId: "msg:corroborating",
      scope: "personal",
    });
    // HAS_STATUS is single_current_value at the registry. The original
    // assistant_inferred claim should be superseded by the new
    // user_confirmed one.
    await seedClaim(rootClient, {
      id: inferredClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Memory refactor is in progress.",
      sourceId: inferredSource,
      objectValue: "in_progress",
      assertedByKind: "assistant_inferred",
      statedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "promote_assertion",
          claimId: inferredClaimId,
          corroboratingSourceId: corroboratingSource,
          reason: "user said yes",
        },
      ],
      buildMapper([]),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);

    const claimsAfter = await rootClient.query<{
      id: string;
      asserted_by_kind: string;
      status: string;
      superseded_by_claim_id: string | null;
    }>(
      `SELECT "id", "asserted_by_kind", "status", "superseded_by_claim_id"
       FROM "claims" WHERE "user_id" = $1
       ORDER BY "stated_at"`,
      [userId],
    );
    expect(claimsAfter.rows).toHaveLength(2);
    const original = claimsAfter.rows.find((r) => r.id === inferredClaimId);
    const promoted = claimsAfter.rows.find((r) => r.id !== inferredClaimId);
    expect(original).toMatchObject({
      asserted_by_kind: "assistant_inferred",
      status: "superseded",
    });
    expect(promoted).toMatchObject({
      asserted_by_kind: "user_confirmed",
      status: "active",
    });
    expect(original?.superseded_by_claim_id).toBe(promoted?.id);
  });

  it("promote_assertion on a multi-valued predicate keeps both rows active", async () => {
    const userId = "user_promote_multi";
    const subjectId = newTypeId("node");
    const inferredSource = newTypeId("source");
    const corroboratingSource = newTypeId("source");
    const inferredClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "fred" },
    ]);
    await seedSource(rootClient, {
      sourceId: inferredSource,
      userId,
      type: "conversation_message",
      externalId: "msg:multi:inferred",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: corroboratingSource,
      userId,
      type: "conversation_message",
      externalId: "msg:multi:corroborating",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: inferredClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_PREFERENCE",
      statement: "Fred likes hiking (inferred).",
      sourceId: inferredSource,
      objectValue: "hiking",
      assertedByKind: "assistant_inferred",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "promote_assertion",
          claimId: inferredClaimId,
          corroboratingSourceId: corroboratingSource,
          reason: "follow-up confirmation",
        },
      ],
      buildMapper([]),
    );
    expect(result.errors).toHaveLength(0);
    expect(result.applied).toBe(1);

    const claimsAfter = await rootClient.query<{
      id: string;
      asserted_by_kind: string;
      status: string;
    }>(
      `SELECT "id", "asserted_by_kind", "status"
       FROM "claims" WHERE "user_id" = $1
       ORDER BY "asserted_by_kind"`,
      [userId],
    );
    expect(claimsAfter.rows).toHaveLength(2);
    expect(claimsAfter.rows.every((r) => r.status === "active")).toBe(true);
    expect(claimsAfter.rows.map((r) => r.asserted_by_kind).sort()).toEqual([
      "assistant_inferred",
      "user_confirmed",
    ]);
  });

  it("promote_assertion rejects non-assistant_inferred originals", async () => {
    const userId = "user_promote_reject";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const corroboratingSource = newTypeId("source");
    const userClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "gina" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "manual",
      externalId: "manual:user_promote_reject",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: corroboratingSource,
      userId,
      type: "manual",
      externalId: "manual:user_promote_reject:corr",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: userClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_PREFERENCE",
      statement: "Gina likes climbing.",
      sourceId,
      objectValue: "climbing",
      assertedByKind: "user",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "promote_assertion",
          claimId: userClaimId,
          corroboratingSourceId: corroboratingSource,
          reason: "shouldn't apply",
        },
      ],
      buildMapper([]),
    );
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/expected assistant_inferred/);

    const claimsAfter = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "claims" WHERE "user_id" = $1`,
      [userId],
    );
    expect(claimsAfter.rows).toHaveLength(1);
  });

  it("retract_claim with claim id outside allowed set is rejected and recorded in errors", async () => {
    const userId = "user_retract_oob";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const insideClaimId = newTypeId("claim");
    const outsideClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "alice" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "manual",
      externalId: "manual:user_retract_oob",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: insideClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Alice is in.",
      sourceId,
      objectValue: "in",
    });
    await seedClaim(rootClient, {
      id: outsideClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Alice is out (other subgraph).",
      sourceId,
      objectValue: "out",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const allowed = new Set<TypeId<"claim">>([insideClaimId]);
    const result = await applyCleanupOperations(
      database,
      userId,
      [{ kind: "retract_claim", claimId: outsideClaimId, reason: "halluc" }],
      buildMapper([]),
      allowed,
    );
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("retract_claim");
    expect(result.errors[0]?.message).toMatch(/outside the rendered subgraph/);

    const after = await rootClient.query<{ status: string }>(
      `SELECT "status" FROM "claims" WHERE "id" = $1`,
      [outsideClaimId],
    );
    expect(after.rows[0]?.status).toBe("active");
  });

  it("contradict_claim with contradictedByClaimId outside allowed set is rejected", async () => {
    const userId = "user_contradict_oob";
    const subjectId = newTypeId("node");
    const sourceId = newTypeId("source");
    const insideClaimId = newTypeId("claim");
    const outsideCitingId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Person", label: "bob" },
    ]);
    await seedSource(rootClient, {
      sourceId,
      userId,
      type: "manual",
      externalId: "manual:user_contradict_oob",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: insideClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Bob is gone.",
      sourceId,
      objectValue: "gone",
    });
    await seedClaim(rootClient, {
      id: outsideCitingId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Bob is here (other subgraph).",
      sourceId,
      objectValue: "here",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const allowed = new Set<TypeId<"claim">>([insideClaimId]);
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "contradict_claim",
          claimId: insideClaimId,
          contradictedByClaimId: outsideCitingId,
          reason: "model cited an unseen claim",
        },
      ],
      buildMapper([]),
      allowed,
    );
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("contradict_claim");
    expect(result.errors[0]?.message).toMatch(
      /cites claim .* outside the rendered subgraph/,
    );

    const after = await rootClient.query<{ status: string }>(
      `SELECT "status" FROM "claims" WHERE "id" = $1`,
      [insideClaimId],
    );
    expect(after.rows[0]?.status).toBe("active");
  });

  it("promote_assertion with claim id outside allowed set is rejected", async () => {
    const userId = "user_promote_oob";
    const subjectId = newTypeId("node");
    const inferredSource = newTypeId("source");
    const corroboratingSource = newTypeId("source");
    const insideClaimId = newTypeId("claim");
    const outsideClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Concept", label: "topic" },
    ]);
    await seedSource(rootClient, {
      sourceId: inferredSource,
      userId,
      type: "conversation_message",
      externalId: "msg:oob:inferred",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: corroboratingSource,
      userId,
      type: "conversation_message",
      externalId: "msg:oob:corroborating",
      scope: "personal",
    });
    await seedClaim(rootClient, {
      id: insideClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Topic is in progress (visible).",
      sourceId: inferredSource,
      objectValue: "in_progress",
      assertedByKind: "assistant_inferred",
    });
    await seedClaim(rootClient, {
      id: outsideClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Topic is paused (other subgraph).",
      sourceId: inferredSource,
      objectValue: "paused",
      assertedByKind: "assistant_inferred",
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const allowed = new Set<TypeId<"claim">>([insideClaimId]);
    const result = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "promote_assertion",
          claimId: outsideClaimId,
          corroboratingSourceId: corroboratingSource,
          reason: "model picked an unseen claim",
        },
      ],
      buildMapper([]),
      allowed,
    );
    expect(result.applied).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.kind).toBe("promote_assertion");
    expect(result.errors[0]?.message).toMatch(/outside the rendered subgraph/);

    // No new claim row should have been created.
    const claimsAfter = await rootClient.query<{ id: string }>(
      `SELECT "id" FROM "claims" WHERE "user_id" = $1`,
      [userId],
    );
    expect(claimsAfter.rows).toHaveLength(2);
  });

  it("promote_assertion supersedes the original even when statedAt collides at the second", async () => {
    // Pins the supersession contract: user_confirmed must outrank
    // assistant_inferred via the lifecycle engine, regardless of whether
    // statedAt differs (past) or ties at the second (same-second batch).
    const userId = "user_promote_tiebreak";
    const subjectId = newTypeId("node");
    const inferredSource = newTypeId("source");
    const corroboratingSource = newTypeId("source");
    const pastClaimId = newTypeId("claim");
    const sameSecondClaimId = newTypeId("claim");

    await seedUserAndNodes(rootClient, userId, [
      { id: subjectId, nodeType: "Concept", label: "topic_tiebreak" },
    ]);
    await seedSource(rootClient, {
      sourceId: inferredSource,
      userId,
      type: "conversation_message",
      externalId: "msg:tiebreak:inferred",
      scope: "personal",
    });
    await seedSource(rootClient, {
      sourceId: corroboratingSource,
      userId,
      type: "conversation_message",
      externalId: "msg:tiebreak:corroborating",
      scope: "personal",
    });

    // Case A: original statedAt one second in the past — promotion should
    // supersede via the strictly-later statedAt.
    const oneSecondAgo = new Date(Date.now() - 1_000);
    await seedClaim(rootClient, {
      id: pastClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_STATUS",
      statement: "Topic is in progress (past stated).",
      sourceId: inferredSource,
      objectValue: "in_progress_past",
      assertedByKind: "assistant_inferred",
      statedAt: oneSecondAgo,
    });

    const { applyCleanupOperations } = await import("./cleanup-operations");
    const pastResult = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "promote_assertion",
          claimId: pastClaimId,
          corroboratingSourceId: corroboratingSource,
          reason: "user confirmed (past)",
        },
      ],
      buildMapper([]),
    );
    expect(pastResult.errors).toHaveLength(0);
    expect(pastResult.applied).toBe(1);

    const pastRow = await rootClient.query<{
      status: string;
      superseded_by_claim_id: string | null;
    }>(
      `SELECT "status", "superseded_by_claim_id" FROM "claims" WHERE "id" = $1`,
      [pastClaimId],
    );
    expect(pastRow.rows[0]?.status).toBe("superseded");
    expect(pastRow.rows[0]?.superseded_by_claim_id).not.toBeNull();

    // Case B: original statedAt = now() and we promote in the same `it`.
    // statedAt may collide at the second; lifecycle must still supersede via
    // the trust-rank tiebreaker (user_confirmed > assistant_inferred).
    await seedClaim(rootClient, {
      id: sameSecondClaimId,
      userId,
      subjectNodeId: subjectId,
      predicate: "HAS_PREFERENCE",
      statement: "Topic is preferred (same-second).",
      sourceId: inferredSource,
      objectValue: "preferred_same_second",
      assertedByKind: "assistant_inferred",
      statedAt: new Date(),
    });
    // HAS_PREFERENCE is multi-valued — substitute single-valued HAS_STATUS
    // with a fresh subject so the same-second case exercises supersession.
    const singleSubjectId = newTypeId("node");
    const singleClaimId = newTypeId("claim");
    await seedUserAndNodes(rootClient, userId, [
      {
        id: singleSubjectId,
        nodeType: "Concept",
        label: "topic_single",
      },
    ]);
    await seedClaim(rootClient, {
      id: singleClaimId,
      userId,
      subjectNodeId: singleSubjectId,
      predicate: "HAS_STATUS",
      statement: "Single topic in progress (same-second).",
      sourceId: inferredSource,
      objectValue: "in_progress_now",
      assertedByKind: "assistant_inferred",
      statedAt: new Date(),
    });
    const sameSecondResult = await applyCleanupOperations(
      database,
      userId,
      [
        {
          kind: "promote_assertion",
          claimId: singleClaimId,
          corroboratingSourceId: corroboratingSource,
          reason: "user confirmed (same-second)",
        },
      ],
      buildMapper([]),
    );
    expect(sameSecondResult.errors).toHaveLength(0);
    expect(sameSecondResult.applied).toBe(1);

    const sameRow = await rootClient.query<{
      status: string;
      superseded_by_claim_id: string | null;
    }>(
      `SELECT "status", "superseded_by_claim_id" FROM "claims" WHERE "id" = $1`,
      [singleClaimId],
    );
    expect(sameRow.rows[0]?.status).toBe("superseded");
    expect(sameRow.rows[0]?.superseded_by_claim_id).not.toBeNull();
  });
});
