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

describeIfServer("extractGraph claim-native insertion", () => {
  const dbName = `memory_extract_graph_test_${Date.now()}_${Math.floor(
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

  async function createExtractionTables(client: Client): Promise<void> {
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

  it("inserts relationships, attributes, aliases, and applies source-scoped replacement", async () => {
    const userId = "user_A";
    const aliceNodeId = newTypeId("node");
    const conversationNodeId = newTypeId("node");
    const parentSourceId = newTypeId("source");
    const messageSourceId = newTypeId("source");
    const oldSourceId = newTypeId("source");
    const staleClaimId = newTypeId("claim");
    const priorStatusId = newTypeId("claim");
    const statedAt = new Date("2026-04-25T10:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    const warnings: string[] = [];
    let prompt = "";
    const originalWarn = console.warn;

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("./graph", () => ({
      findSimilarNodes: async () => [],
      findOneHopNodes: async () => [],
      findNodesByType: async () => [
        {
          id: aliceNodeId,
          type: "Person",
          label: "Alice",
          description: "Generated Alice profile",
          timestamp: new Date("2026-04-01T00:00:00.000Z"),
          similarity: 1,
        },
      ],
    }));
    vi.doMock("./embeddings-util", () => ({
      generateAndInsertClaimEmbeddings: async () => undefined,
      generateAndInsertNodeEmbeddings: async () => undefined,
    }));
    vi.doMock("./debug-utils", () => ({
      debugGraph: () => undefined,
    }));
    vi.doMock("./ai", () => ({
      createCompletionClient: async () => ({
        beta: {
          chat: {
            completions: {
              parse: async (input: {
                messages: Array<{ content: string }>;
              }) => {
                prompt = input.messages[0]?.content ?? "";
                return {
                  choices: [
                    {
                      message: {
                        parsed: {
                          nodes: [
                            {
                              id: "project_1",
                              type: "Object",
                              label: "Project Falcon",
                              description: "A project Alice discussed.",
                            },
                          ],
                          relationshipClaims: [
                            {
                              subjectId: "existing_person_1",
                              objectId: "project_1",
                              predicate: "TAGGED_WITH",
                              statement: "Alice discussed Project Falcon.",
                              sourceRef: "msg_1",
                              assertionKind: "user",
                            },
                            {
                              subjectId: "existing_person_1",
                              objectId: "project_1",
                              predicate: "RELATED_TO",
                              statement: "This claim has a bad source.",
                              sourceRef: "missing_msg",
                              assertionKind: "user",
                            },
                          ],
                          attributeClaims: [
                            {
                              subjectId: "existing_person_1",
                              predicate: "HAS_STATUS",
                              objectValue: "completed",
                              statement: "Alice completed Project Falcon.",
                              sourceRef: "msg_1",
                              statedAt: statedAt.toISOString(),
                              assertionKind: "user",
                            },
                            {
                              subjectId: "existing_person_1",
                              predicate: "HAS_GOAL",
                              objectValue: "bad decorated source ref",
                              statement: "This claim copied the timestamp too.",
                              sourceRef: "msg_1 (2026-04-25T10:00:00.000Z)",
                              assertionKind: "user",
                            },
                          ],
                          aliases: [
                            {
                              subjectId: "existing_person_1",
                              aliasText: "Ally",
                            },
                            {
                              subjectId: "existing_person_1",
                              aliasText: " ",
                            },
                          ],
                        },
                      },
                    },
                  ],
                };
              },
            },
          },
        },
      }),
    }));

    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      await createExtractionTables(client);

      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, $3, 'Person'),
              ($2, $3, 'Conversation')
        `,
        [aliceNodeId, conversationNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $3, 'Alice', 'alice', 'Generated Alice profile'),
              ($2, $4, 'Conversation', 'conversation', 'Conversation source node')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          aliceNodeId,
          conversationNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES
              ($1, $4, 'conversation', 'conv_1', 'completed'),
              ($2, $4, 'conversation_message', 'msg_1', 'completed'),
              ($3, $4, 'manual', 'manual:user_A', 'completed')
        `,
        [parentSourceId, messageSourceId, oldSourceId, userId],
      );
      await database.insert(schema.claims).values([
        {
          id: staleClaimId,
          userId,
          subjectNodeId: aliceNodeId,
          objectValue: "stale",
          predicate: "HAS_PREFERENCE",
          statement: "This stale claim should be replaced.",
          sourceId: messageSourceId,
          assertedByKind: "user",
          statedAt: new Date("2026-04-24T10:00:00.000Z"),
          status: "active",
        },
        {
          id: priorStatusId,
          userId,
          subjectNodeId: aliceNodeId,
          objectValue: "started",
          predicate: "HAS_STATUS",
          statement: "Alice started Project Falcon.",
          sourceId: oldSourceId,
          assertedByKind: "user",
          statedAt: new Date("2026-04-24T09:00:00.000Z"),
          status: "active",
        },
      ]);

      const { extractGraph } = await import("./extract-graph");
      const result = await extractGraph({
        userId,
        sourceType: "conversation",
        sourceId: parentSourceId,
        statedAt,
        linkedNodeId: conversationNodeId,
        sourceRefs: [
          {
            externalId: "msg_1",
            sourceId: messageSourceId,
            statedAt,
          },
        ],
        content:
          '<message id="msg_1" role="user">Ally completed Project Falcon.</message>',
      });

      expect(result).toEqual({ newNodesCreated: 1, claimsCreated: 2 });
      expect(prompt).toContain(
        "- sourceRef: msg_1; statedAt: 2026-04-25T10:00:00.000Z",
      );
      expect(prompt).not.toContain("- msg_1 (2026-04-25T10:00:00.000Z)");
      expect(warnings).toContain(
        "Skipping claim with invalid sourceRef: missing_msg",
      );
      expect(warnings).toContain(
        "Skipping attribute claim with invalid sourceRef: msg_1 (2026-04-25T10:00:00.000Z)",
      );
      expect(warnings).toContain(
        "Skipping empty alias for node reference: existing_person_1",
      );

      const claimRows = await client.query<{
        id: string;
        predicate: string;
        source_id: string;
        object_value: string | null;
        status: string;
      }>(
        `
          SELECT "id", "predicate", "source_id", "object_value", "status"
          FROM "claims"
          WHERE "user_id" = $1
          ORDER BY "statement"
        `,
        [userId],
      );
      expect(claimRows.rows).toHaveLength(3);
      expect(claimRows.rows.some((row) => row.id === staleClaimId)).toBe(false);
      expect(
        claimRows.rows.filter((row) => row.source_id === messageSourceId),
      ).toHaveLength(2);
      expect(
        claimRows.rows.find((row) => row.predicate === "HAS_STATUS"),
      ).toMatchObject({
        object_value: "completed",
        source_id: messageSourceId,
        status: "active",
      });
      expect(
        claimRows.rows.find((row) => row.id === priorStatusId),
      ).toMatchObject({ status: "superseded" });

      const aliases = await client.query<{
        alias_text: string;
        normalized_alias_text: string;
        canonical_node_id: string;
      }>(
        `
          SELECT "alias_text", "normalized_alias_text", "canonical_node_id"
          FROM "aliases"
          WHERE "user_id" = $1
        `,
        [userId],
      );
      expect(aliases.rows).toEqual([
        {
          alias_text: "Ally",
          normalized_alias_text: "ally",
          canonical_node_id: aliceNodeId,
        },
      ]);
    } finally {
      console.warn = originalWarn;
      vi.doUnmock("~/utils/db");
      vi.doUnmock("./graph");
      vi.doUnmock("./embeddings-util");
      vi.doUnmock("./debug-utils");
      vi.doUnmock("./ai");
      vi.resetModules();
      await client.end();
    }
  });

  it("injects open tasks into the prompt and supersedes them via HAS_TASK_STATUS", async () => {
    const userId = "user_tasks";
    const taskNodeId = newTypeId("node");
    const conversationNodeId = newTypeId("node");
    const parentSourceId = newTypeId("source");
    const messageSourceId = newTypeId("source");
    const taskSourceId = newTypeId("source");
    const priorTaskStatusId = newTypeId("claim");
    const initialStatusAt = new Date("2026-04-20T10:00:00.000Z");
    const replacementStatusAt = new Date("2026-04-26T10:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    let prompt = "";

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("./graph", () => ({
      findSimilarNodes: async () => [],
      findOneHopNodes: async () => [],
      findNodesByType: async () => [],
    }));
    vi.doMock("./embeddings-util", () => ({
      generateAndInsertClaimEmbeddings: async () => undefined,
      generateAndInsertNodeEmbeddings: async () => undefined,
    }));
    vi.doMock("./debug-utils", () => ({
      debugGraph: () => undefined,
    }));
    vi.doMock("./ai", () => ({
      createCompletionClient: async () => ({
        beta: {
          chat: {
            completions: {
              parse: async (input: {
                messages: Array<{ content: string }>;
              }) => {
                prompt = input.messages[0]?.content ?? "";
                return {
                  choices: [
                    {
                      message: {
                        parsed: {
                          nodes: [],
                          relationshipClaims: [],
                          attributeClaims: [
                            {
                              subjectId: taskNodeId,
                              predicate: "HAS_TASK_STATUS",
                              objectValue: "done",
                              statement: "User completed the spec write-up.",
                              sourceRef: "msg_task_done",
                              statedAt: replacementStatusAt.toISOString(),
                              assertionKind: "user",
                            },
                          ],
                          aliases: [],
                        },
                      },
                    },
                  ],
                };
              },
            },
          },
        },
      }),
    }));

    try {
      await createExtractionTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, $3, 'Task'),
              ($2, $3, 'Conversation')
        `,
        [taskNodeId, conversationNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $3, 'Write spec doc', 'write spec doc', null),
              ($2, $4, 'Conversation', 'conversation', 'Conversation source node')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          taskNodeId,
          conversationNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES
              ($1, $4, 'conversation', 'conv_tasks', 'completed'),
              ($2, $4, 'conversation_message', 'msg_task_done', 'completed'),
              ($3, $4, 'conversation_message', 'msg_task_seed', 'completed')
        `,
        [parentSourceId, messageSourceId, taskSourceId, userId],
      );
      await database.insert(schema.claims).values([
        {
          id: priorTaskStatusId,
          userId,
          subjectNodeId: taskNodeId,
          objectValue: "pending",
          predicate: "HAS_TASK_STATUS",
          statement: "User committed to writing the spec doc.",
          sourceId: taskSourceId,
          assertedByKind: "user",
          statedAt: initialStatusAt,
          validFrom: initialStatusAt,
          status: "active",
        },
      ]);

      const { extractGraph } = await import("./extract-graph");
      const result = await extractGraph({
        userId,
        sourceType: "conversation",
        sourceId: parentSourceId,
        statedAt: replacementStatusAt,
        linkedNodeId: conversationNodeId,
        sourceRefs: [
          {
            externalId: "msg_task_done",
            sourceId: messageSourceId,
            statedAt: replacementStatusAt,
          },
        ],
        content:
          '<message id="msg_task_done" role="user">I finished the spec doc.</message>',
      });

      expect(result).toEqual({ newNodesCreated: 0, claimsCreated: 1 });

      // Prompt should contain the open-tasks section listing the existing
      // task by its node id, label, and current status.
      expect(prompt).toContain("CURRENT OPEN TASKS:");
      expect(prompt).toContain(`existingNodeId: ${taskNodeId}`);
      expect(prompt).toContain("label: Write spec doc");
      expect(prompt).toContain("status: pending");

      const claimRows = await client.query<{
        id: string;
        predicate: string;
        object_value: string | null;
        status: string;
        superseded_by_claim_id: string | null;
      }>(
        `
          SELECT "id", "predicate", "object_value", "status", "superseded_by_claim_id"
          FROM "claims"
          WHERE "user_id" = $1 AND "predicate" = 'HAS_TASK_STATUS'
          ORDER BY "stated_at" ASC
        `,
        [userId],
      );

      expect(claimRows.rows).toHaveLength(2);
      const [prior, latest] = claimRows.rows;
      expect(prior).toMatchObject({
        id: priorTaskStatusId,
        object_value: "pending",
        status: "superseded",
      });
      expect(prior?.superseded_by_claim_id).toBe(latest?.id);
      expect(latest).toMatchObject({
        object_value: "done",
        status: "active",
        superseded_by_claim_id: null,
      });
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("./graph");
      vi.doUnmock("./embeddings-util");
      vi.doUnmock("./debug-utils");
      vi.doUnmock("./ai");
      vi.resetModules();
      await client.end();
    }
  });

  it("renders a 'no open tasks' line when the user has none", async () => {
    const userId = "user_no_tasks";
    const conversationNodeId = newTypeId("node");
    const parentSourceId = newTypeId("source");
    const messageSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    let prompt = "";

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("./graph", () => ({
      findSimilarNodes: async () => [],
      findOneHopNodes: async () => [],
      findNodesByType: async () => [],
    }));
    vi.doMock("./embeddings-util", () => ({
      generateAndInsertClaimEmbeddings: async () => undefined,
      generateAndInsertNodeEmbeddings: async () => undefined,
    }));
    vi.doMock("./debug-utils", () => ({
      debugGraph: () => undefined,
    }));
    vi.doMock("./ai", () => ({
      createCompletionClient: async () => ({
        beta: {
          chat: {
            completions: {
              parse: async (input: {
                messages: Array<{ content: string }>;
              }) => {
                prompt = input.messages[0]?.content ?? "";
                return {
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
                };
              },
            },
          },
        },
      }),
    }));

    try {
      await createExtractionTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Conversation')
        `,
        [conversationNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES ($1, $2, 'Conversation', 'conversation', null)
        `,
        [newTypeId("node_metadata"), conversationNodeId],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES
              ($1, $3, 'conversation', 'conv_no_tasks', 'completed'),
              ($2, $3, 'conversation_message', 'msg_empty', 'completed')
        `,
        [parentSourceId, messageSourceId, userId],
      );

      const { extractGraph } = await import("./extract-graph");
      await extractGraph({
        userId,
        sourceType: "conversation",
        sourceId: parentSourceId,
        statedAt: new Date("2026-04-26T10:00:00.000Z"),
        linkedNodeId: conversationNodeId,
        sourceRefs: [
          {
            externalId: "msg_empty",
            sourceId: messageSourceId,
            statedAt: new Date("2026-04-26T10:00:00.000Z"),
          },
        ],
        content: '<message id="msg_empty" role="user">Hello.</message>',
      });

      expect(prompt).toContain("CURRENT OPEN TASKS:");
      expect(prompt).toContain("- (no open tasks)");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("./graph");
      vi.doUnmock("./embeddings-util");
      vi.doUnmock("./debug-utils");
      vi.doUnmock("./ai");
      vi.resetModules();
      await client.end();
    }
  });

  it("reactivates the previous status when reprocessing removes the active source claim", async () => {
    const userId = "user_B";
    const aliceNodeId = newTypeId("node");
    const conversationNodeId = newTypeId("node");
    const parentSourceId = newTypeId("source");
    const messageSourceId = newTypeId("source");
    const oldSourceId = newTypeId("source");
    const priorStatusId = newTypeId("claim");
    const deletedStatusId = newTypeId("claim");
    const previousStatusAt = new Date("2026-04-20T10:00:00.000Z");
    const replacementStatusAt = new Date("2026-04-25T10:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));
    vi.doMock("./graph", () => ({
      findSimilarNodes: async () => [],
      findOneHopNodes: async () => [],
      findNodesByType: async () => [
        {
          id: aliceNodeId,
          type: "Person",
          label: "Alice",
          description: "Generated Alice profile",
          timestamp: new Date("2026-04-01T00:00:00.000Z"),
          similarity: 1,
        },
      ],
    }));
    vi.doMock("./embeddings-util", () => ({
      generateAndInsertClaimEmbeddings: async () => undefined,
      generateAndInsertNodeEmbeddings: async () => undefined,
    }));
    vi.doMock("./debug-utils", () => ({
      debugGraph: () => undefined,
    }));
    vi.doMock("./ai", () => ({
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

    try {
      await createExtractionTables(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `
          INSERT INTO "nodes" ("id", "user_id", "node_type")
            VALUES
              ($1, $3, 'Person'),
              ($2, $3, 'Conversation')
        `,
        [aliceNodeId, conversationNodeId, userId],
      );
      await client.query(
        `
          INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label", "description")
            VALUES
              ($1, $3, 'Alice', 'alice', 'Generated Alice profile'),
              ($2, $4, 'Conversation', 'conversation', 'Conversation source node')
        `,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          aliceNodeId,
          conversationNodeId,
        ],
      );
      await client.query(
        `
          INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
            VALUES
              ($1, $4, 'conversation', 'conv_2', 'completed'),
              ($2, $4, 'conversation_message', 'msg_2', 'completed'),
              ($3, $4, 'manual', 'manual:user_B', 'completed')
        `,
        [parentSourceId, messageSourceId, oldSourceId, userId],
      );
      await database.insert(schema.claims).values([
        {
          id: priorStatusId,
          userId,
          subjectNodeId: aliceNodeId,
          objectValue: "started",
          predicate: "HAS_STATUS",
          statement: "Alice started Project Falcon.",
          sourceId: oldSourceId,
          assertedByKind: "user",
          statedAt: previousStatusAt,
          validFrom: previousStatusAt,
          validTo: replacementStatusAt,
          status: "superseded",
        },
        {
          id: deletedStatusId,
          userId,
          subjectNodeId: aliceNodeId,
          objectValue: "completed",
          predicate: "HAS_STATUS",
          statement: "Alice completed Project Falcon.",
          sourceId: messageSourceId,
          assertedByKind: "user",
          statedAt: replacementStatusAt,
          validFrom: replacementStatusAt,
          status: "active",
        },
      ]);

      const { extractGraph } = await import("./extract-graph");
      const result = await extractGraph({
        userId,
        sourceType: "conversation",
        sourceId: parentSourceId,
        statedAt: replacementStatusAt,
        linkedNodeId: conversationNodeId,
        sourceRefs: [
          {
            externalId: "msg_2",
            sourceId: messageSourceId,
            statedAt: replacementStatusAt,
          },
        ],
        content:
          '<message id="msg_2" role="user">No status fact here.</message>',
      });

      expect(result).toEqual({ newNodesCreated: 0, claimsCreated: 0 });

      const rows = await client.query<{
        id: string;
        status: string;
        valid_to: Date | null;
      }>(
        `
          SELECT "id", "status", "valid_to"
          FROM "claims"
          WHERE "user_id" = $1
        `,
        [userId],
      );

      expect(rows.rows).toEqual([
        {
          id: priorStatusId,
          status: "active",
          valid_to: null,
        },
      ]);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.doUnmock("./graph");
      vi.doUnmock("./embeddings-util");
      vi.doUnmock("./debug-utils");
      vi.doUnmock("./ai");
      vi.resetModules();
      await client.end();
    }
  });
});
