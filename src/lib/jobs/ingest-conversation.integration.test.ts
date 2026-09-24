import { normalizeLabel } from "../label";
import type { LlmOutputNode } from "../schemas/llm-extraction";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { createStubSourceService } from "~/evals/memory/extraction-stubs";
import { newTypeId, type TypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";
import {
  resetTestOverrides,
  setExtractionClientOverride,
  setSkipEmbeddingPersistence,
  setSkipJobEnqueue,
  setSkipSemanticSearch,
  setSourceServiceOverride,
  type StubCompletionClient,
} from "~/utils/test-overrides";

// Commitment writes may schedule maintenance; never start a queue worker here.
vi.mock("../queues", () => ({
  batchQueue: { add: async () => undefined },
}));

process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

const port = Number(process.env["TEST_PG_PORT"] ?? 5431);
const host = process.env["TEST_PG_HOST"] ?? "localhost";
const user = process.env["TEST_PG_USER"] ?? "postgres";
const password = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const dsn = (name: string): string =>
  `postgres://${user}:${password}@${host}:${port}/${name}`;
const adminDsn = dsn(process.env["TEST_PG_ADMIN_DB"] ?? "postgres");

async function available(): Promise<boolean> {
  const client = new Client({ connectionString: adminDsn });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}
const describeWithDatabase = (await available()) ? describe : describe.skip;

/**
 * Plays the extraction model: finds the user's node id in the prompt, the way
 * the model reads it, and assigns one task to it. Two more tasks name their
 * owner instead, which exercises identity resolution on labels.
 */
function extractionClient(capture: { prompt: string }): StubCompletionClient {
  const parse = async (body: {
    messages: Array<{ content: string }>;
    response_format?: { json_schema?: { name?: string } };
  }) => {
    if (body.response_format?.json_schema?.name !== "subgraph") {
      return {
        choices: [{ message: { parsed: { excerpt: null, why: null } } }],
      };
    }
    capture.prompt = body.messages.map((message) => message.content).join("\n");
    const selfNodeId = capture.prompt.match(
      /The user:\n- nodeId: (node_[a-z0-9]+)/,
    )?.[1];
    const sourceRef = capture.prompt.match(/- sourceRef: (\S+);/)?.[1];
    if (selfNodeId === undefined || sourceRef === undefined) {
      throw new Error("The prompt names no user node or source ref");
    }
    const task = (id: string, label: string): LlmOutputNode => ({
      id,
      type: "Task",
      label,
    });
    const assign = (taskId: string, ownerId: string, statement: string) => ({
      subjectId: taskId,
      objectId: ownerId,
      predicate: "ASSIGNED_TO" as const,
      statement,
      sourceRef,
      assertionKind: "user" as const,
    });
    const pending = (taskId: string, statement: string) => ({
      subjectId: taskId,
      predicate: "HAS_TASK_STATUS" as const,
      objectValue: "pending",
      statement,
      sourceRef,
      assertionKind: "user" as const,
    });
    return {
      choices: [
        {
          message: {
            parsed: {
              nodes: [
                task("temp_task_1", "Send Jan the contract"),
                task("temp_task_2", "Book the dentist"),
                task("temp_task_3", "Review the offsite draft"),
                { id: "temp_person_1", type: "Person", label: "Marcel Samyn" },
                { id: "temp_person_2", type: "Person", label: "Marcel" },
              ],
              relationshipClaims: [
                assign(
                  "temp_task_1",
                  selfNodeId,
                  "The user will send Jan the contract.",
                ),
                assign(
                  "temp_task_2",
                  "temp_person_1",
                  "Marcel Samyn will book the dentist.",
                ),
                assign(
                  "temp_task_3",
                  "temp_person_2",
                  "Marcel will review the offsite draft.",
                ),
              ],
              attributeClaims: [
                pending("temp_task_1", "Sending Jan the contract is pending."),
                pending("temp_task_2", "Booking the dentist is pending."),
                pending(
                  "temp_task_3",
                  "Reviewing the offsite draft is pending.",
                ),
              ],
              aliases: [],
            },
          },
        },
      ],
    };
  };
  return {
    chat: { completions: { parse } },
  } as unknown as StubCompletionClient;
}

describeWithDatabase("ingestConversation self assignment", () => {
  const dbName = `memory_conversation_self_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let pool: Pool;
  let database: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    pool = new Pool({ connectionString: dsn(dbName), max: 4 });
    database = drizzle(pool, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    setTestDatabase(database);
    setSourceServiceOverride(createStubSourceService(database));
    setSkipEmbeddingPersistence(true);
    setSkipSemanticSearch(true);
    setSkipJobEnqueue(true);
  }, 120_000);

  afterAll(async () => {
    resetTestOverrides();
    setTestDatabase(null);
    await pool?.end();
    const admin = new Client({ connectionString: adminDsn });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  async function addPerson(
    userId: string,
    label: string,
  ): Promise<TypeId<"node">> {
    const id = newTypeId("node");
    await database
      .insert(schema.nodes)
      .values({ id, userId, nodeType: "Person" });
    await database.insert(schema.nodeMetadata).values({
      nodeId: id,
      label,
      canonicalLabel: normalizeLabel(label),
      additionalData: {},
    });
    return id;
  }

  async function ownerOf(
    userId: string,
    taskLabel: string,
  ): Promise<TypeId<"node"> | null | undefined> {
    const [row] = await database
      .select({ ownerId: schema.claims.objectNodeId })
      .from(schema.claims)
      .innerJoin(
        schema.nodeMetadata,
        eq(schema.nodeMetadata.nodeId, schema.claims.subjectNodeId),
      )
      .where(
        and(
          eq(schema.claims.userId, userId),
          eq(schema.claims.predicate, "ASSIGNED_TO"),
          eq(schema.nodeMetadata.label, taskLabel),
        ),
      );
    return row?.ownerId;
  }

  it("assigns the user's own task to the flagged self node and keeps it through the dedup sweep", async () => {
    const userId = "user_conversation_self";
    await database.insert(schema.users).values({ id: userId });
    // Aliases stored through an earlier settings write; this partition has
    // no self node yet.
    await database.insert(schema.userProfiles).values({
      id: newTypeId("user_profile"),
      userId,
      content: "",
      metadata: { userSelfAliases: ["Marcel", "Marcel Samyn"] },
    });
    // Older Person nodes named like the user, minted by earlier extractions.
    const olderFullNameId = await addPerson(userId, "Marcel Samyn");
    const bareNameId = await addPerson(userId, "Marcel");

    const capture = { prompt: "" };
    setExtractionClientOverride(extractionClient(capture));
    try {
      const { ingestConversation } = await import("./ingest-conversation");
      await ingestConversation({
        db: database,
        userId,
        conversationId: "chat_self_owner",
        messages: [
          {
            id: "msg_1",
            role: "user",
            content:
              "I'll send Jan the contract tomorrow, and I need to book the dentist.",
            timestamp: new Date("2026-09-20T09:00:00.000Z"),
          },
        ],
      });
    } finally {
      setExtractionClientOverride(null);
    }

    const selfRows = await database
      .select({ id: schema.nodes.id, label: schema.nodeMetadata.label })
      .from(schema.nodes)
      .innerJoin(
        schema.nodeMetadata,
        eq(schema.nodeMetadata.nodeId, schema.nodes.id),
      )
      .where(
        and(
          eq(schema.nodes.userId, userId),
          sql`${schema.nodeMetadata.additionalData}->'isUserSelf' = 'true'::jsonb`,
        ),
      );
    expect(selfRows).toHaveLength(1);
    const selfNodeId = selfRows[0]!.id;
    expect(selfRows[0]!.label).toBe("Marcel Samyn");
    expect(capture.prompt).toContain(`The user:\n- nodeId: ${selfNodeId};`);
    // Only the older duplicate is offered as an existing Person by that name.
    expect(capture.prompt.split("<label>Marcel Samyn</label>")).toHaveLength(2);

    // The id the model was given, and the exact multi-word self alias, both
    // reach the flagged node. A bare first name stays with its own node.
    expect(await ownerOf(userId, "Send Jan the contract")).toBe(selfNodeId);
    expect(await ownerOf(userId, "Book the dentist")).toBe(selfNodeId);
    expect(await ownerOf(userId, "Review the offsite draft")).toBe(bareNameId);

    // The older same-named Person would absorb the newer self node if the
    // sweep merged it.
    const { runDedupSweep } = await import("./dedup-sweep");
    await runDedupSweep(userId);

    expect(await ownerOf(userId, "Send Jan the contract")).toBe(selfNodeId);
    expect(await ownerOf(userId, "Book the dentist")).toBe(selfNodeId);
    const survivingDuplicate = await database
      .select({ id: schema.nodes.id })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, olderFullNameId));
    expect(survivingDuplicate).toHaveLength(1);

    const { getCandidateCommitments } = await import(
      "../query/open-commitments"
    );
    const candidates = await getCandidateCommitments({ userId });
    const ownerByLabel = new Map(
      candidates.map((commitment) => [commitment.label, commitment.owner]),
    );
    expect(ownerByLabel.get("Send Jan the contract")).toBeNull();
    expect(ownerByLabel.get("Book the dentist")).toBeNull();
    expect(ownerByLabel.get("Review the offsite draft")).toMatchObject({
      nodeId: bareNameId,
      label: "Marcel",
    });
  }, 60_000);
});
