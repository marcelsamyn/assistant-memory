/**
 * DB-integration tests for the transcript ingestion pipeline (Phase 4 PR
 * 4ii-b). Real Postgres; LLM and embedding/search side effects are stubbed.
 *
 * Coverage:
 * - Pre-segmented input: parent + child sources, speaker provenance metadata,
 *   participant claims with `assertedByNodeId`, user-self collapses to
 *   `assertedByKind = 'user'`.
 * - Placeholder Person creation for unresolved speakers (with
 *   `additionalData.unresolvedSpeaker = true` and an alias row).
 * - Raw input runs the segmenter stub end-to-end.
 * - `userSelfAliasesOverride` overrides stored aliases for one ingestion.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import type { SegmentTranscriptClient } from "~/lib/transcript/segment-transcript";
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

describeIfServer("ingestTranscript", () => {
  const dbName = `memory_ingest_transcript_test_${Date.now()}_${Math.floor(
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

  async function createTranscriptTables(client: Client): Promise<void> {
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
        "parent_source" text,
        "scope" varchar(16) DEFAULT 'personal' NOT NULL,
        "metadata" jsonb,
        "last_ingested_at" timestamp with time zone,
        "status" varchar(20) DEFAULT 'pending',
        "content_type" varchar(100),
        "content_length" integer,
        "deleted_at" timestamp with time zone,
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
        CONSTRAINT "aliases_user_normalized_canonical_unique"
          UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
      );
      CREATE TABLE IF NOT EXISTS "user_profiles" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "content" text NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);
  }

  /**
   * Mock the source service so inline child sources are persisted directly via
   * the supplied DB without touching MinIO. Mirrors the production behavior
   * closely enough for the assertions below: status flips to 'completed',
   * `metadata.rawContent` and any caller-supplied metadata keys land on the row.
   */
  function mockSourceService(database: ReturnType<typeof drizzle>) {
    return {
      sourceService: {
        async insertMany(
          inputs: Array<{
            userId: string;
            sourceType: string;
            externalId: string;
            parentId?: TypeId<"source">;
            scope?: string;
            timestamp: Date;
            content?: string;
            metadata?: Record<string, unknown>;
          }>,
        ) {
          const successes: TypeId<"source">[] = [];
          const failures: Array<{ reason: string }> = [];
          for (const input of inputs) {
            const id = newTypeId("source");
            const metadata = {
              ...(input.metadata ?? {}),
              ...(input.content !== undefined
                ? { rawContent: input.content }
                : {}),
            };
            const [inserted] = await database
              .insert(schema.sources)
              .values({
                id,
                userId: input.userId,
                type: input.sourceType as schema.SourcesInsert["type"],
                externalId: input.externalId,
                parentSource: input.parentId ?? null,
                scope:
                  (input.scope as schema.SourcesInsert["scope"]) ?? "personal",
                metadata,
                lastIngestedAt: input.timestamp,
                status: "completed",
              })
              .onConflictDoNothing({
                target: [
                  schema.sources.userId,
                  schema.sources.type,
                  schema.sources.externalId,
                ],
              })
              .returning();
            if (inserted) successes.push(inserted.id);
          }
          return { successes, failures };
        },
        async fetchRaw() {
          return [];
        },
        async fetchText() {
          return "";
        },
        async deleteHard() {
          /* no-op */
        },
      },
      ensureSystemSource: async () => newTypeId("source"),
    };
  }

  function applyCommonMocks(database: ReturnType<typeof drizzle>) {
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("~/lib/sources", () => mockSourceService(database));
    // The importers (`src/lib/extract-graph.ts`, `src/lib/jobs/...`) use
    // relative specifiers, but Vitest normalizes mocks against the resolved
    // module path. From `src/lib/jobs/`, `../graph` resolves to the same
    // module that extract-graph.ts loads via `./graph`.
    vi.doMock("../graph", () => ({
      findSimilarNodes: async () => [],
      findOneHopNodes: async () => [],
      findNodesByType: async () => [],
    }));
    vi.doMock("../embeddings-util", () => ({
      generateAndInsertClaimEmbeddings: async () => undefined,
      generateAndInsertNodeEmbeddings: async () => undefined,
    }));
    // `ensureDayNode` (called from `ensureSourceNode`) embeds the day label
    // via Jina in production. Replace it with a minimal real-DB stub: insert
    // a Temporal node and return its id. The OCCURRED_ON claim that
    // `ensureSourceNode` writes then satisfies its FK to nodes(id).
    vi.doMock("../temporal", () => ({
      ensureDayNode: async (
        _db: ReturnType<typeof drizzle>,
        userId: string,
      ) => {
        const id = newTypeId("node");
        await database
          .insert(schema.nodes)
          .values({ id, userId, nodeType: "Temporal" });
        return id;
      },
    }));
    vi.doMock("../debug-utils", () => ({
      debugGraph: () => undefined,
    }));
    vi.doMock("./atlas-invalidation", () => ({
      maybeEnqueueAtlasInvalidation: async () => undefined,
    }));
    vi.doMock("../queues", () => ({
      batchQueue: { add: async () => undefined },
    }));
  }

  function unmockCommon() {
    vi.doUnmock("~/utils/db");
    vi.doUnmock("~/lib/sources");
    vi.doUnmock("../graph");
    vi.doUnmock("../embeddings-util");
    vi.doUnmock("../temporal");
    vi.doUnmock("../debug-utils");
    vi.doUnmock("./atlas-invalidation");
    vi.doUnmock("../queues");
    vi.doUnmock("../ai");
    vi.resetModules();
  }

  it("ingests a pre-segmented multi-party transcript, attributes claims by speaker, and creates a placeholder for unresolved speakers", async () => {
    const userId = "user_transcript_a";
    const transcriptId = "trans_a_1";
    const occurredAt = new Date("2026-04-30T10:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    applyCommonMocks(database);
    vi.doMock("../ai", () => ({
      createCompletionClient: async () => ({
        beta: {
          chat: {
            completions: {
              parse: async () => ({
                choices: [
                  {
                    message: {
                      parsed: {
                        nodes: [
                          {
                            id: "spec_1",
                            type: "Object",
                            label: "the spec",
                            description: "Spec doc discussed in meeting",
                          },
                        ],
                        relationshipClaims: [],
                        attributeClaims: [
                          {
                            subjectId: "spec_1",
                            predicate: "HAS_STATUS",
                            objectValue: "completed",
                            statement: "Marcel completed the spec.",
                            sourceRef: `${transcriptId}:0`,
                            assertionKind: "user",
                            assertedBySpeakerLabel: "Marcel",
                          },
                          {
                            subjectId: "spec_1",
                            predicate: "HAS_PREFERENCE",
                            objectValue: "tighter spec",
                            statement: "Bob prefers a tighter spec.",
                            sourceRef: `${transcriptId}:1`,
                            assertionKind: "participant",
                            assertedBySpeakerLabel: "Bob",
                          },
                          {
                            subjectId: "spec_1",
                            predicate: "HAS_GOAL",
                            objectValue: "ship by friday",
                            statement: "Stranger wants to ship by Friday.",
                            sourceRef: `${transcriptId}:2`,
                            assertionKind: "participant",
                            assertedBySpeakerLabel: "Stranger",
                          },
                        ],
                        aliases: [],
                      },
                    },
                  },
                ],
              }),
            },
          },
        },
      }),
    }));

    try {
      await createTranscriptTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setUserSelfAliases } = await import("../user-profile");
      await setUserSelfAliases(database, userId, ["Marcel"]);

      // Pre-create a Person node Bob so the speaker resolver finds him via
      // the knownParticipants path (rather than minting a placeholder).
      const bobNodeId = newTypeId("node");
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [bobNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'Bob', 'bob')`,
        [newTypeId("node_metadata"), bobNodeId],
      );

      const { ingestTranscript } = await import("./ingest-transcript");
      const result = await ingestTranscript({
        db: database,
        userId,
        transcriptId,
        scope: "personal",
        occurredAt,
        content: {
          kind: "segmented",
          utterances: [
            { speakerLabel: "Marcel", content: "I shipped the spec." },
            {
              speakerLabel: "Bob",
              content: "Cool — I'd prefer a tighter spec next round.",
            },
            {
              speakerLabel: "Stranger",
              content: "Either way, let's ship by Friday.",
            },
          ],
        },
        knownParticipants: [{ label: "Bob", nodeId: bobNodeId }],
      });

      expect(result.utteranceCount).toBe(3);
      expect(result.unresolvedSpeakers).toBe(1);

      // Parent + child sources
      const sourceRows = await client.query<{
        id: string;
        type: string;
        external_id: string;
        parent_source: string | null;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT id, type, external_id, parent_source, metadata FROM sources WHERE user_id = $1 ORDER BY external_id ASC`,
        [userId],
      );
      const parents = sourceRows.rows.filter(
        (row) => row.type === "meeting_transcript",
      );
      const children = sourceRows.rows.filter(
        (row) => row.type === "conversation_message",
      );
      expect(parents).toHaveLength(1);
      expect(children).toHaveLength(3);
      expect(parents[0]?.external_id).toBe(transcriptId);
      for (const child of children) {
        expect(child.parent_source).toBe(parents[0]?.id);
        expect(child.metadata?.["speakerLabel"]).toBeTypeOf("string");
        expect(child.metadata?.["speakerNodeId"]).toBeTypeOf("string");
      }

      // Claim provenance
      const claimRows = await client.query<{
        predicate: string;
        object_value: string | null;
        asserted_by_kind: string;
        asserted_by_node_id: string | null;
      }>(
        `SELECT predicate, object_value, asserted_by_kind, asserted_by_node_id
         FROM claims
         WHERE user_id = $1 AND predicate IN ('HAS_STATUS', 'HAS_PREFERENCE', 'HAS_GOAL')
         ORDER BY predicate ASC`,
        [userId],
      );
      expect(claimRows.rows).toHaveLength(3);
      const byPred = new Map(claimRows.rows.map((row) => [row.predicate, row]));
      expect(byPred.get("HAS_STATUS")).toMatchObject({
        asserted_by_kind: "user",
        asserted_by_node_id: null,
      });
      const bobClaim = byPred.get("HAS_PREFERENCE");
      expect(bobClaim?.asserted_by_kind).toBe("participant");
      expect(bobClaim?.asserted_by_node_id).toBe(bobNodeId);
      const strangerClaim = byPred.get("HAS_GOAL");
      expect(strangerClaim?.asserted_by_kind).toBe("participant");
      expect(strangerClaim?.asserted_by_node_id).toBeTruthy();

      // Placeholder Person for "Stranger"
      const placeholderRows = await client.query<{
        node_id: string;
        label: string;
        additional_data: Record<string, unknown> | null;
      }>(
        `SELECT nm.node_id, nm.label, nm.additional_data
         FROM node_metadata nm
         JOIN nodes n ON n.id = nm.node_id
         WHERE n.user_id = $1
           AND n.node_type = 'Person'
           AND nm.label = 'Stranger'`,
        [userId],
      );
      expect(placeholderRows.rows).toHaveLength(1);
      expect(placeholderRows.rows[0]?.additional_data).toMatchObject({
        unresolvedSpeaker: true,
      });

      // Alias row for "Stranger" pointing at the placeholder
      const aliasRows = await client.query<{
        normalized_alias_text: string;
        canonical_node_id: string;
      }>(
        `SELECT normalized_alias_text, canonical_node_id FROM aliases WHERE user_id = $1`,
        [userId],
      );
      const strangerAlias = aliasRows.rows.find(
        (row) => row.normalized_alias_text === "stranger",
      );
      expect(strangerAlias?.canonical_node_id).toBe(
        placeholderRows.rows[0]?.node_id,
      );

      // user-self Person node exists with isUserSelf flag
      const userSelfRows = await client.query<{
        id: string;
        additional_data: Record<string, unknown> | null;
      }>(
        `SELECT n.id, nm.additional_data
         FROM nodes n
         JOIN node_metadata nm ON nm.node_id = n.id
         WHERE n.user_id = $1 AND n.node_type = 'Person'
           AND (nm.additional_data ->> 'isUserSelf') = 'true'`,
        [userId],
      );
      expect(userSelfRows.rows).toHaveLength(1);
    } finally {
      unmockCommon();
      await client.end();
    }
  });

  it("segments raw input via the supplied client and runs the pipeline end-to-end", async () => {
    const userId = "user_transcript_b";
    const transcriptId = "trans_b_1";
    const occurredAt = new Date("2026-04-30T11:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    applyCommonMocks(database);
    vi.doMock("../ai", () => ({
      createCompletionClient: async () => ({
        beta: {
          chat: {
            completions: {
              parse: async () => ({
                choices: [
                  {
                    message: {
                      parsed: {
                        nodes: [],
                        relationshipClaims: [],
                        attributeClaims: [],
                        aliases: [],
                      },
                    },
                  },
                ],
              }),
            },
          },
        },
      }),
    }));

    const segmenter: SegmentTranscriptClient = {
      segment: async () => [
        { speakerLabel: "Speaker 1", content: "Welcome everyone." },
        { speakerLabel: "Speaker 2", content: "Thanks for having me." },
      ],
    };

    try {
      await createTranscriptTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { ingestTranscript } = await import("./ingest-transcript");
      const result = await ingestTranscript({
        db: database,
        userId,
        transcriptId,
        scope: "personal",
        occurredAt,
        content: { kind: "raw", text: "raw transcript text" },
        segmenter,
      });

      expect(result.utteranceCount).toBe(2);
      const sourceRows = await client.query<{
        type: string;
        external_id: string;
      }>(
        `SELECT type, external_id FROM sources WHERE user_id = $1 ORDER BY external_id ASC`,
        [userId],
      );
      expect(
        sourceRows.rows.filter((row) => row.type === "meeting_transcript"),
      ).toHaveLength(1);
      expect(
        sourceRows.rows.filter((row) => row.type === "conversation_message"),
      ).toHaveLength(2);
    } finally {
      unmockCommon();
      await client.end();
    }
  });

  it("respects userSelfAliasesOverride for a single ingestion", async () => {
    const userId = "user_transcript_c";
    const transcriptId = "trans_c_1";
    const occurredAt = new Date("2026-04-30T12:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    applyCommonMocks(database);
    vi.doMock("../ai", () => ({
      createCompletionClient: async () => ({
        beta: {
          chat: {
            completions: {
              parse: async () => ({
                choices: [
                  {
                    message: {
                      parsed: {
                        nodes: [
                          {
                            id: "topic_1",
                            type: "Concept",
                            label: "Override topic",
                          },
                        ],
                        relationshipClaims: [],
                        attributeClaims: [
                          {
                            subjectId: "topic_1",
                            predicate: "HAS_PREFERENCE",
                            objectValue: "override works",
                            statement: "MS prefers the override path.",
                            sourceRef: `${transcriptId}:0`,
                            assertionKind: "user",
                            assertedBySpeakerLabel: "MS",
                          },
                        ],
                        aliases: [],
                      },
                    },
                  },
                ],
              }),
            },
          },
        },
      }),
    }));

    try {
      await createTranscriptTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setUserSelfAliases } = await import("../user-profile");
      // Stored alias does NOT include "MS" — only the override does.
      await setUserSelfAliases(database, userId, ["Marcel"]);

      const { ingestTranscript } = await import("./ingest-transcript");
      await ingestTranscript({
        db: database,
        userId,
        transcriptId,
        scope: "personal",
        occurredAt,
        content: {
          kind: "segmented",
          utterances: [
            {
              speakerLabel: "MS",
              content: "Override should resolve me to user-self.",
            },
          ],
        },
        userSelfAliasesOverride: ["MS"],
      });

      const claimRows = await client.query<{
        asserted_by_kind: string;
        asserted_by_node_id: string | null;
      }>(
        `SELECT asserted_by_kind, asserted_by_node_id FROM claims WHERE user_id = $1 AND predicate = 'HAS_PREFERENCE'`,
        [userId],
      );
      expect(claimRows.rows).toHaveLength(1);
      expect(claimRows.rows[0]).toMatchObject({
        asserted_by_kind: "user",
        asserted_by_node_id: null,
      });
    } finally {
      unmockCommon();
      await client.end();
    }
  });
});
