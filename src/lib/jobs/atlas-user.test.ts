import {
  composeAtlasContent,
  rankAtlasClaims,
  renderAtlasClaimsBlock,
} from "./atlas-user";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
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

async function createAtlasUserTestTables(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "content" text NOT NULL,
      "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL
    );
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

describe("rankAtlasClaims (pure ranking)", () => {
  const subjectA = "node_a" as TypeId<"node">;
  const subjectB = "node_b" as TypeId<"node">;
  const asOf = new Date("2026-04-28T00:00:00.000Z");

  function makeClaim(
    id: string,
    subjectNodeId: TypeId<"node">,
    statedAt: Date,
  ): Parameters<typeof rankAtlasClaims>[0][number] {
    return {
      id: id as TypeId<"claim">,
      predicate: "HAS_GOAL",
      statement: `goal ${id}`,
      objectValue: `value-${id}`,
      statedAt,
      subjectNodeId,
      subjectLabel: subjectNodeId === subjectA ? "Subject A" : "Subject B",
      assertedByKind: "user",
    };
  }

  it("ranks high-centrality subjects above low-centrality subjects", () => {
    const candidates = [
      makeClaim("a1", subjectA, new Date("2026-04-27T00:00:00.000Z")),
      makeClaim("a2", subjectA, new Date("2026-04-26T00:00:00.000Z")),
      makeClaim("a3", subjectA, new Date("2026-04-25T00:00:00.000Z")),
      makeClaim("a4", subjectA, new Date("2026-04-24T00:00:00.000Z")),
      makeClaim("a5", subjectA, new Date("2026-04-23T00:00:00.000Z")),
      makeClaim("b1", subjectB, new Date("2026-04-27T00:00:00.000Z")),
    ];
    const centrality = new Map<TypeId<"node">, number>([
      [subjectA, 5],
      [subjectB, 1],
    ]);

    const ranked = rankAtlasClaims(candidates, centrality, asOf);

    // Subject A's most-recent claim outranks subject B's most-recent claim.
    expect(ranked[0]?.subjectNodeId).toBe(subjectA);
    expect(ranked[0]?.centrality).toBe(5);
  });

  it("caps claims per subject at MAX_CLAIMS_PER_SUBJECT", () => {
    const candidates = Array.from({ length: 10 }, (_, idx) =>
      makeClaim(
        `a${idx.toString()}`,
        subjectA,
        new Date(`2026-04-${(10 + idx).toString().padStart(2, "0")}T00:00:00.000Z`),
      ),
    );
    const centrality = new Map<TypeId<"node">, number>([[subjectA, 10]]);

    const ranked = rankAtlasClaims(candidates, centrality, asOf);
    expect(ranked.length).toBeLessThanOrEqual(5);
  });
});

describe("composeAtlasContent", () => {
  it("renders pinned-then-derived when both present", () => {
    const composed = composeAtlasContent("Stay calm.", "Marcel ships things.");
    expect(composed).toBe("# Pinned\nStay calm.\n\n# Derived\nMarcel ships things.");
  });

  it("omits pinned section when empty", () => {
    expect(composeAtlasContent("", "derived only")).toBe(
      "# Derived\nderived only",
    );
  });

  it("omits derived section when empty", () => {
    expect(composeAtlasContent("pinned only", "")).toBe(
      "# Pinned\npinned only",
    );
  });
});

describe("renderAtlasClaimsBlock", () => {
  it("includes subject label and centrality", () => {
    const block = renderAtlasClaimsBlock([
      {
        id: "c1" as TypeId<"claim">,
        predicate: "HAS_GOAL",
        statement: "Marcel ships the claims layer.",
        objectValue: "ship claims layer",
        statedAt: new Date("2026-04-20T00:00:00.000Z"),
        subjectNodeId: "n1" as TypeId<"node">,
        subjectLabel: "Marcel",
        assertedByKind: "user",
        centrality: 3,
        ageDays: 8,
        score: 1.4,
      },
    ]);
    expect(block).toContain('subject="Marcel"');
    expect(block).toContain("centrality=3");
    expect(block).toContain("HAS_GOAL=ship claims layer");
  });
});

describeIfServer("processAtlasJob", () => {
  const dbName = `memory_atlas_user_test_${Date.now().toString()}_${Math.floor(Math.random() * 1e6).toString()}`;

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

  it("synthesises atlas from trusted personal claims, excludes assistant_inferred and reference, concatenates pinned content, and is idempotent on rerun", async () => {
    const userId = "user_atlas_basic";
    const personNodeId = newTypeId("node");
    const projectNodeId = newTypeId("node");
    const personalSourceId = newTypeId("source");
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
          atlas:
            "Marcel is a senior engineer who values concise communication and is currently focused on shipping the claims layer.",
        };
      },
    }));

    try {
      await createAtlasUserTestTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "user_profiles" ("id", "user_id", "content") VALUES ($1, $2, $3)`,
        [newTypeId("user_profile"), userId, "I prefer concise, direct answers."],
      );
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $3, 'Person'),
          ($2, $3, 'Object')`,
        [personNodeId, projectNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES
          ($1, $3, 'Marcel'),
          ($2, $4, 'Claims Layer')`,
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
        [personalSourceId, referenceSourceId, userId],
      );

      await database.insert(schema.claims).values([
        // Trusted personal — should appear in prompt.
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "concise communication",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel prefers concise communication.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "ship the claims layer in Q2",
          predicate: "HAS_GOAL",
          statement: "Marcel will ship the claims layer in Q2.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "user_confirmed",
          statedAt: new Date("2026-04-21T10:00:00.000Z"),
          status: "active",
        },
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: projectNodeId,
          objectValue: "in_progress",
          predicate: "HAS_STATUS",
          statement: "Claims Layer is in progress.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-22T10:00:00.000Z"),
          status: "active",
        },
        // MADE_DECISION is feedsAtlas=false → excluded.
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "DECISION_THAT_SHOULD_NOT_LEAK",
          predicate: "MADE_DECISION",
          statement: "Marcel decided to use Postgres.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-23T10:00:00.000Z"),
          status: "active",
        },
        // Decoy: assistant_inferred — excluded.
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "INFERRED_LEAK",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel might prefer matcha.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "assistant_inferred",
          statedAt: new Date("2026-04-24T10:00:00.000Z"),
          status: "active",
        },
        // Decoy: reference scope — excluded.
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "REFERENCE_LEAK",
          predicate: "HAS_PREFERENCE",
          statement: "Marcus Aurelius preferred stoicism.",
          sourceId: referenceSourceId,
          scope: "reference",
          assertedByKind: "document_author",
          statedAt: new Date("2026-04-25T10:00:00.000Z"),
          status: "active",
        },
        // Decoy: superseded — excluded.
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: projectNodeId,
          objectValue: "SUPERSEDED_LEAK",
          predicate: "HAS_STATUS",
          statement: "Claims Layer was pending.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-19T10:00:00.000Z"),
          status: "superseded",
        },
      ]);

      const { processAtlasJob } = await import("./atlas-user");
      const result = await processAtlasJob(database, userId);

      expect(result.status).toBe("synthesised");
      expect(llmCallCount).toBe(1);
      expect(lastSchemaName).toBe("AtlasUserOutput");

      // Trusted claims must be in the prompt.
      expect(lastPrompt).toContain("HAS_PREFERENCE=concise communication");
      expect(lastPrompt).toContain("HAS_GOAL=ship the claims layer in Q2");
      expect(lastPrompt).toContain("HAS_STATUS=in_progress");
      // Decoys must NOT be in the prompt.
      expect(lastPrompt).not.toContain("INFERRED_LEAK");
      expect(lastPrompt).not.toContain("REFERENCE_LEAK");
      expect(lastPrompt).not.toContain("SUPERSEDED_LEAK");
      expect(lastPrompt).not.toContain("DECISION_THAT_SHOULD_NOT_LEAK");
      // Pinned content is in the prompt as a hands-off block.
      expect(lastPrompt).toContain("I prefer concise, direct answers.");

      // Storage: written to atlas node metadata, with hash on additionalData.
      const atlasRow = await client.query<{
        description: string | null;
        additional_data: { atlasUserHash?: string } | null;
      }>(
        `SELECT nm.description, nm.additional_data
         FROM nodes n
         JOIN node_metadata nm ON nm.node_id = n.id
         WHERE n.user_id = $1 AND n.node_type = 'Atlas'`,
        [userId],
      );
      const stored = atlasRow.rows[0];
      expect(stored?.description).toContain("# Pinned");
      expect(stored?.description).toContain("I prefer concise, direct answers.");
      expect(stored?.description).toContain("# Derived");
      expect(stored?.description).toContain("senior engineer");
      const hash = stored?.additional_data?.atlasUserHash;
      expect(typeof hash).toBe("string");
      expect((hash ?? "").length).toBeGreaterThan(16);

      // Idempotence: second run with unchanged inputs is a cache hit.
      const second = await processAtlasJob(database, userId);
      expect(second.status).toBe("skipped_cache_hit");
      expect(llmCallCount).toBe(1);

      // Empty pinned content path: drop user_profiles row, change a claim, rerun.
      await client.query(`DELETE FROM "user_profiles" WHERE "user_id" = $1`, [
        userId,
      ]);
      await database.insert(schema.claims).values([
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: personNodeId,
          objectValue: "deep work in mornings",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel prefers deep work in mornings.",
          sourceId: personalSourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T10:00:00.000Z"),
          status: "active",
        },
      ]);
      const third = await processAtlasJob(database, userId);
      expect(third.status).toBe("synthesised");
      expect(llmCallCount).toBe(2);
      expect(third.content?.startsWith("# Pinned")).toBe(false);
      expect(third.content?.startsWith("# Derived")).toBe(true);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("../ai");
      vi.resetModules();
      await client.end();
    }
  });

  it("centrality ranking: a busy subject pushes its claims into the prompt over a sparse subject", async () => {
    const userId = "user_atlas_centrality";
    const busyNodeId = newTypeId("node");
    const sparseNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    let lastPrompt = "";

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    vi.doMock("../ai", () => ({
      performStructuredAnalysis: async (input: { prompt: string }) => {
        lastPrompt = input.prompt;
        return { atlas: "ok" };
      },
    }));

    try {
      await createAtlasUserTestTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES
          ($1, $3, 'Person'),
          ($2, $3, 'Object')`,
        [busyNodeId, sparseNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label") VALUES
          ($1, $3, 'BusyPerson'),
          ($2, $4, 'SparseTopic')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          busyNodeId,
          sparseNodeId,
        ],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status") VALUES
          ($1, $2, 'conversation_message', 'msg_central', 'personal', 'completed')`,
        [sourceId, userId],
      );

      const baseDate = new Date("2026-04-20T10:00:00.000Z");
      const busyClaims = Array.from({ length: 5 }, (_, idx) => ({
        id: newTypeId("claim"),
        userId,
        subjectNodeId: busyNodeId,
        objectValue: `busy_pref_${idx.toString()}`,
        predicate: "HAS_PREFERENCE" as const,
        statement: `BusyPerson preference ${idx.toString()}.`,
        sourceId,
        scope: "personal" as const,
        assertedByKind: "user" as const,
        // Older than the sparse claim so time-in-effect doesn't help busy.
        statedAt: new Date(baseDate.getTime() - (idx + 1) * 86400_000),
        status: "active" as const,
      }));
      await database.insert(schema.claims).values([
        ...busyClaims,
        {
          id: newTypeId("claim"),
          userId,
          subjectNodeId: sparseNodeId,
          objectValue: "sparse_pref",
          predicate: "HAS_PREFERENCE",
          statement: "SparseTopic singleton preference.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          // Brand-new (lowest age) → highest time component.
          statedAt: new Date("2026-04-28T00:00:00.000Z"),
          status: "active",
        },
      ]);

      const { processAtlasJob } = await import("./atlas-user");
      const result = await processAtlasJob(database, userId);
      expect(result.status).toBe("synthesised");

      const busyIndex = lastPrompt.indexOf('subject="BusyPerson"');
      const sparseIndex = lastPrompt.indexOf('subject="SparseTopic"');
      expect(busyIndex).toBeGreaterThanOrEqual(0);
      expect(sparseIndex).toBeGreaterThanOrEqual(0);
      // Centrality dominates the time bonus on the sparse-but-recent claim.
      expect(busyIndex).toBeLessThan(sparseIndex);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("../ai");
      vi.resetModules();
      await client.end();
    }
  });

  it("HAS_STATUS supersession enqueues an atlas-user refresh via the invalidation hook", async () => {
    const userId = "user_atlas_supersede";
    const subjectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    const enqueueCalls: Array<{ name: string; data: unknown; opts: unknown }> =
      [];

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
    vi.doMock("../queues", () => ({
      batchQueue: {
        add: async (name: string, data: unknown, opts: unknown) => {
          enqueueCalls.push({ name, data, opts });
          return undefined;
        },
      },
      // Bundle-cache invalidation runs alongside atlas-user enqueue and
      // calls `redisConnection.del` — provide a minimal stub.
      redisConnection: {
        get: async () => null,
        set: async () => "OK" as const,
        del: async () => 0,
      },
    }));

    try {
      await createAtlasUserTestTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Object')`,
        [subjectNodeId, userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope") VALUES
          ($1, $2, 'conversation_message', 'msg_supersede', 'personal')`,
        [sourceId, userId],
      );

      const firstClaimId = newTypeId("claim");
      const secondClaimId = newTypeId("claim");
      await database.insert(schema.claims).values([
        {
          id: firstClaimId,
          userId,
          subjectNodeId,
          objectValue: "in_progress",
          predicate: "HAS_STATUS",
          statement: "Project is in progress.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-20T10:00:00.000Z"),
          status: "active",
        },
        {
          id: secondClaimId,
          userId,
          subjectNodeId,
          objectValue: "done",
          predicate: "HAS_STATUS",
          statement: "Project is done.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-04-25T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const since = new Date(Date.now() - 60_000);
      const { applyClaimLifecycle } = await import("../claims/lifecycle");
      const inserted = await database
        .select()
        .from(schema.claims)
        .where(eq(schema.claims.userId, userId));
      await applyClaimLifecycle(database, inserted);

      const { maybeEnqueueAtlasInvalidation } = await import(
        "./atlas-invalidation"
      );
      const triggered = await maybeEnqueueAtlasInvalidation(
        database,
        userId,
        since,
      );
      expect(triggered).toBe(true);

      expect(enqueueCalls).toHaveLength(1);
      expect(enqueueCalls[0]?.name).toBe("atlas-user");
      expect(
        (enqueueCalls[0]?.opts as { jobId?: string }).jobId,
      ).toBe(`atlas-user:${userId}:supersede`);
      expect(
        (enqueueCalls[0]?.opts as { delay?: number }).delay,
      ).toBeGreaterThan(0);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("../queues");
      vi.resetModules();
      await client.end();
    }
  });
});
