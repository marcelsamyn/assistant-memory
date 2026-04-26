/**
 * End-to-end regression test: ingest a conversation via `extractGraph`, then
 * verify `searchMemory` returns the extracted node and claim. Acts as a safety
 * net for the in-progress claims-layer (Phase 2b) refactor — the existing test
 * suite never exercises ingest -> store -> search end to end.
 *
 * Real Postgres (with pgvector) is required; the suite is skipped if no DB is
 * reachable (matches the pattern in `extract-graph.test.ts` and
 * `migrations-claims.test.ts`). The LLM, embeddings API, and reranker are
 * mocked deterministically — everything else (schema, claim lifecycle,
 * embedding storage, similarity search) runs against the real database.
 */
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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

// --- Deterministic embeddings -------------------------------------------------
//
// Token-overlap vectors: tokenize text, hash each token to a dimension index,
// add 1 there, then L2-normalize. Identical tokens -> overlapping vectors ->
// high cosine similarity. This lets the real DB-side cosine search rank the
// "Memory Refactor" project highly for a query containing the same words,
// without hitting the network.

const EMBEDDING_DIM = 1024;

// Stopwords + structural tokens emitted by `claimEmbeddingText`. Filtering
// these out concentrates similarity on content-bearing words so the query
// "Memory Refactor project" actually clears the 0.4 minimumSimilarity gate
// in `findSimilarClaims` without us having to lower thresholds in product
// code. Real embeddings handle this implicitly; deterministic test
// embeddings need help.
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "i",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "they",
  "this",
  "to",
  "was",
  "were",
  "with",
  "you",
  "active",
  "status",
  "statedat",
  "currently",
  "another",
  "user",
  "users",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function hashTokenToDim(token: string): number {
  let hash = 5381;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) + hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % EMBEDDING_DIM;
}

function deterministicEmbedding(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIM).fill(0);
  for (const token of tokenize(text)) {
    vector[hashTokenToDim(token)]! += 1;
  }
  // L2 normalize so cosine similarity reduces to dot product over [0, 1].
  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
  if (norm === 0) {
    // Avoid an all-zero vector — cosine distance against zero is undefined and
    // will be filtered out by `findSimilarNodes` (it requires similarity IS
    // NOT NULL). Fall back to a single fixed dimension so empty/weird inputs
    // still produce a usable vector.
    vector[0] = 1;
    return vector;
  }
  return vector.map((v) => v / norm);
}

describeIfServer("ingest -> search end-to-end", () => {
  const dbName = `memory_ingest_search_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();

    const database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
  }, 60_000);

  afterAll(async () => {
    await client.end();
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

  it(
    "extracts claims from a conversation and surfaces them via searchMemory",
    async () => {
      const userId = "user_e2e";
      const otherUserId = "user_other";
      const projectLabel = "Memory Refactor";
      const orgLabel = "Acme Corp";
      const personLabel = "Marcel Samyn";

      const personNodeId = newTypeId("node");
      const conversationNodeId = newTypeId("node");
      const conversationSourceId = newTypeId("source");
      const messageSourceId = newTypeId("source");
      const otherUserSourceId = newTypeId("source");
      const otherUserNodeId = newTypeId("node");
      const otherUserConversationNodeId = newTypeId("node");
      const otherUserClaimId = newTypeId("claim");
      const statedAt = new Date("2026-04-26T10:00:00.000Z");

      const database = drizzle(client, { schema, casing: "snake_case" });

      vi.resetModules();
      vi.doMock("~/utils/db", () => ({
        useDatabase: async () => database,
      }));

      // Mock the LLM: deterministic extraction of one Project + one Object,
      // both linked back to the existing Person, plus an attribute claim and
      // an alias.
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
                          nodes: [
                            {
                              id: "project_1",
                              type: "Concept",
                              label: projectLabel,
                              description:
                                "Refactor of the assistant memory substrate from edges to claims.",
                            },
                            {
                              id: "org_1",
                              type: "Object",
                              label: orgLabel,
                              description: "Employer organization.",
                            },
                          ],
                          relationshipClaims: [
                            {
                              subjectId: "existing_person_1",
                              objectId: "project_1",
                              predicate: "PARTICIPATED_IN",
                              statement: `${personLabel} is working on the ${projectLabel} project.`,
                              sourceRef: "msg_1",
                            },
                            {
                              subjectId: "project_1",
                              objectId: "org_1",
                              predicate: "RELATED_TO",
                              statement: `${projectLabel} is a project at ${orgLabel}.`,
                              sourceRef: "msg_1",
                            },
                          ],
                          attributeClaims: [
                            {
                              subjectId: "project_1",
                              predicate: "HAS_STATUS",
                              objectValue: "in_progress",
                              statement: `${projectLabel} is currently in progress.`,
                              sourceRef: "msg_1",
                            },
                          ],
                          aliases: [
                            {
                              subjectId: "project_1",
                              aliasText: "the refactor",
                            },
                          ],
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

      // Mock embeddings: deterministic token-overlap vectors. Same text -> same
      // vector; overlapping tokens -> high cosine similarity. Real DB-side
      // cosine search runs unmodified against these.
      vi.doMock("./embeddings", () => ({
        generateEmbeddings: async (params: { input: string[] }) => ({
          data: params.input.map((text) => ({
            embedding: deterministicEmbedding(text),
          })),
          usage: { total_tokens: 0 },
        }),
      }));

      // Mock the reranker: pass-through preserving group/item, scoring by
      // descending insertion order so assertions are stable.
      vi.doMock("./rerank", () => ({
        rerankMultiple: async <Groups extends Record<string, unknown>>(
          _query: string,
          groups: {
            [K in keyof Groups]: {
              items: Groups[K][];
              toDocument: (item: Groups[K]) => string;
            };
          },
        ) => {
          const flat: Array<{
            group: keyof Groups;
            item: Groups[keyof Groups];
            relevance_score: number;
          }> = [];
          for (const groupKey of Object.keys(groups) as Array<keyof Groups>) {
            for (const item of groups[groupKey].items) {
              flat.push({
                group: groupKey,
                item: item as Groups[keyof Groups],
                relevance_score: 1,
              });
            }
          }
          return flat;
        },
        rerank: async () => ({ results: [] }),
      }));

      try {
        // --- Set up user, the canonical Person node, and a conversation
        // source/node. This mirrors what the real ingestion job would have
        // already created before calling extractGraph.
        await database.insert(schema.users).values([
          { id: userId },
          { id: otherUserId },
        ]);
        await database.insert(schema.nodes).values([
          { id: personNodeId, userId, nodeType: "Person" },
          { id: conversationNodeId, userId, nodeType: "Conversation" },
          {
            id: otherUserNodeId,
            userId: otherUserId,
            nodeType: "Concept",
          },
          {
            id: otherUserConversationNodeId,
            userId: otherUserId,
            nodeType: "Conversation",
          },
        ]);
        await database.insert(schema.nodeMetadata).values([
          {
            nodeId: personNodeId,
            label: personLabel,
            canonicalLabel: personLabel.toLowerCase(),
            description: "The user.",
          },
          {
            nodeId: conversationNodeId,
            label: "Conversation",
            canonicalLabel: "conversation",
          },
          {
            nodeId: otherUserNodeId,
            label: projectLabel,
            canonicalLabel: projectLabel.toLowerCase(),
            description:
              "Another user's project that should not leak across users.",
          },
          {
            nodeId: otherUserConversationNodeId,
            label: "Other Conversation",
            canonicalLabel: "other conversation",
          },
        ]);
        await database.insert(schema.sources).values([
          {
            id: conversationSourceId,
            userId,
            type: "conversation",
            externalId: "conv_1",
            status: "completed",
          },
          {
            id: messageSourceId,
            userId,
            type: "conversation_message",
            externalId: "msg_1",
            status: "completed",
          },
          {
            id: otherUserSourceId,
            userId: otherUserId,
            type: "conversation_message",
            externalId: "other_msg_1",
            status: "completed",
          },
        ]);

        // Seed a claim + embedding for the OTHER user, mentioning the same
        // project label, to verify the per-user filter doesn't leak.
        await database.insert(schema.claims).values({
          id: otherUserClaimId,
          userId: otherUserId,
          subjectNodeId: otherUserNodeId,
          objectValue: "in_progress",
          predicate: "HAS_STATUS",
          statement: `Other user's ${projectLabel} project is in progress.`,
          sourceId: otherUserSourceId,
          assertedByKind: "user",
          statedAt,
          status: "active",
        });
        await database.insert(schema.nodeEmbeddings).values({
          nodeId: otherUserNodeId,
          embedding: deterministicEmbedding(
            `${projectLabel}: Another user's project that should not leak across users.`,
          ),
          modelName: "jina-embeddings-v3",
        });
        await database.insert(schema.claimEmbeddings).values({
          claimId: otherUserClaimId,
          embedding: deterministicEmbedding(
            `HAS_STATUS Other user's ${projectLabel} project is in progress. status=active statedAt=${statedAt.toISOString()}`,
          ),
          modelName: "jina-embeddings-v3",
        });

        // --- Run the real extraction pipeline.
        const { extractGraph } = await import("./extract-graph");
        const extractionResult = await extractGraph({
          userId,
          sourceType: "conversation",
          sourceId: conversationSourceId,
          statedAt,
          linkedNodeId: conversationNodeId,
          sourceRefs: [
            {
              externalId: "msg_1",
              sourceId: messageSourceId,
              statedAt,
            },
          ],
          content: `<message id="msg_1" role="user">I'm working on the ${projectLabel} project at ${orgLabel}.</message>`,
        });

        expect(extractionResult).toEqual({
          newNodesCreated: 2,
          claimsCreated: 3,
        });

        // Sanity: the real DB now contains the project node, its embedding,
        // and the three claims with their embeddings.
        const projectNodeRows = await database
          .select({
            id: schema.nodes.id,
            label: schema.nodeMetadata.label,
            type: schema.nodes.nodeType,
          })
          .from(schema.nodes)
          .innerJoin(
            schema.nodeMetadata,
            eq(schema.nodes.id, schema.nodeMetadata.nodeId),
          )
          .where(
            and(
              eq(schema.nodes.userId, userId),
              eq(schema.nodeMetadata.label, projectLabel),
            ),
          );
        expect(projectNodeRows).toHaveLength(1);
        const projectNodeId = projectNodeRows[0]!.id as TypeId<"node">;
        expect(projectNodeRows[0]!.type).toBe("Concept");

        // --- Run search with the real searchMemory pipeline. The LLM is not
        // involved here; only embeddings + DB cosine search + reranker mock.
        const { searchMemory } = await import("./query/search");
        const result = await searchMemory({
          userId,
          query: `${projectLabel} project`,
          limit: 10,
          excludeNodeTypes: [],
        });

        expect(result.query).toBe(`${projectLabel} project`);

        const nodeMatches = result.searchResults.filter(
          (item) => item.group === "similarNodes",
        );
        const claimMatches = result.searchResults.filter(
          (item) => item.group === "similarClaims",
        );

        // The Project node we just ingested must appear in the search results.
        const projectInResults = nodeMatches.find(
          (item) => item.item.id === projectNodeId,
        );
        expect(projectInResults).toBeDefined();
        expect(projectInResults!.item.label).toBe(projectLabel);

        // At least one claim about the project must be retrievable.
        const projectClaim = claimMatches.find(
          (item) =>
            item.item.subjectNodeId === projectNodeId ||
            item.item.objectNodeId === projectNodeId,
        );
        expect(projectClaim).toBeDefined();

        // userId scoping: the other user's identically-labeled project node
        // and claim must NOT leak into this user's results.
        const leakedNode = nodeMatches.find(
          (item) => item.item.id === otherUserNodeId,
        );
        expect(leakedNode).toBeUndefined();
        const leakedClaim = claimMatches.find(
          (item) => item.item.id === otherUserClaimId,
        );
        expect(leakedClaim).toBeUndefined();
      } finally {
        vi.doUnmock("~/utils/db");
        vi.doUnmock("./ai");
        vi.doUnmock("./embeddings");
        vi.doUnmock("./rerank");
        vi.resetModules();
      }
    },
    60_000,
  );
});
