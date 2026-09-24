/**
 * Pins the Tasks read path at realistic size: one list of 150 open tasks with
 * owners, due dates, history, and presentation sources costs a fixed number of
 * queries instead of growing per row.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  claims,
  commitmentPresentations,
  memoryPartitions,
  nodeMetadata,
  nodes,
  partitionMigrationState,
  sources,
  users,
} from "~/db/schema";
import { MEMORY_PERSONAL_PARTITION_KEY } from "~/lib/schemas/partition";
import { newTypeId, type TypeId } from "~/types/typeid";

process.env["DATABASE_URL"] ??=
  "postgres://postgres:postgres@localhost:5431/postgres";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "https://api.openai.com/v1";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test-model";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

const { createMigratedTestDb, isServerReachable } = await import(
  "~/lib/search/test-db"
);
const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

const OPEN_TASKS = 150;
const DONE_TASKS = 300;
const partitionKey = MEMORY_PERSONAL_PARTITION_KEY;

describeIfServer("commitment read query count", () => {
  const userId = "user_commitment_reads";
  const queries: string[] = [];
  const selfOwnedTaskIds = new Set<TypeId<"node">>();
  let handle: Awaited<ReturnType<typeof createMigratedTestDb>>;

  beforeAll(async () => {
    handle = await createMigratedTestDb(
      `memory_commitment_reads_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    );
    const { db } = handle;
    await db.insert(users).values({ id: userId });
    await db
      .insert(partitionMigrationState)
      .values({ userId, state: "migrated" });
    await db
      .insert(memoryPartitions)
      .values({ userId, partitionKey, status: "active" });

    const nodeRows: Array<typeof nodes.$inferInsert> = [];
    const metadataRows: Array<typeof nodeMetadata.$inferInsert> = [];
    const sourceRows: Array<typeof sources.$inferInsert> = [];
    const claimRows: Array<typeof claims.$inferInsert> = [];
    const presentationRows: Array<typeof commitmentPresentations.$inferInsert> =
      [];
    const addNode = (
      nodeType: (typeof nodes.$inferInsert)["nodeType"],
      label: string,
      additionalData?: Record<string, unknown>,
    ): TypeId<"node"> => {
      const id = newTypeId("node");
      nodeRows.push({ id, userId, partitionKey, nodeType });
      metadataRows.push({
        nodeId: id,
        label,
        canonicalLabel: label.toLowerCase(),
        additionalData,
      });
      return id;
    };

    const selfId = addNode("Person", "Marcel Samyn", { isUserSelf: true });
    const people = Array.from({ length: 10 }, (_, i) =>
      addNode("Person", `Person ${i}`),
    );
    const days = Array.from({ length: 30 }, (_, i) =>
      addNode("Temporal", `2026-10-${String(i + 1).padStart(2, "0")}`),
    );
    const claimBase = { userId, partitionKey, statement: "seed" } as const;

    for (let i = 0; i < OPEN_TASKS + DONE_TASKS; i++) {
      const open = i < OPEN_TASKS;
      const taskId = addNode("Task", `Task ${i}`);
      const sourceId = newTypeId("source");
      sourceRows.push({
        id: sourceId,
        userId,
        partitionKey,
        type: "conversation",
        externalId: `conversation-${i}`,
        status: "completed",
        metadata: { title: `Conversation ${i}` },
      });
      const statedAt = new Date(Date.UTC(2026, 8, 1, 0, i));
      claimRows.push(
        {
          ...claimBase,
          subjectNodeId: taskId,
          predicate: "HAS_TASK_STATUS",
          objectValue: "pending",
          sourceId,
          assertedByKind: "assistant_inferred",
          statedAt: new Date(statedAt.getTime() - 60_000),
          status: "superseded",
        },
        {
          ...claimBase,
          subjectNodeId: taskId,
          predicate: "HAS_TASK_STATUS",
          objectValue: open ? "pending" : "done",
          sourceId,
          assertedByKind: "user",
          statedAt,
          status: "active",
        },
        {
          ...claimBase,
          subjectNodeId: taskId,
          predicate: "ASSIGNED_TO",
          objectNodeId: i % 3 === 0 ? selfId : people[i % people.length]!,
          sourceId,
          assertedByKind: "user",
          statedAt,
          status: "active",
        },
        {
          ...claimBase,
          subjectNodeId: taskId,
          predicate: "DUE_ON",
          objectNodeId: days[i % days.length]!,
          sourceId,
          assertedByKind: "user",
          statedAt,
          status: "active",
        },
      );
      if (open && i % 3 === 0) selfOwnedTaskIds.add(taskId);
      if (open && i % 2 === 0) {
        presentationRows.push({ taskId, userId, sourceId, excerpt: "excerpt" });
      }
    }

    await db.transaction(async (tx) => {
      await tx.insert(nodes).values(nodeRows);
      await tx.insert(nodeMetadata).values(metadataRows);
      await tx.insert(sources).values(sourceRows);
      await tx.insert(claims).values(claimRows);
      await tx.insert(commitmentPresentations).values(presentationRows);
    });

    const observedDb = drizzle(handle.client, {
      schema,
      casing: "snake_case",
      logger: { logQuery: (query) => queries.push(query) },
    });
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => observedDb }));
  });

  afterAll(async () => {
    vi.doUnmock("~/utils/db");
    vi.resetModules();
    await handle?.drop();
  });

  it("lists every open task in two queries", async () => {
    const { listCommitments } = await import("./commitments-list");
    const { listCommitmentsRequestSchema } = await import(
      "~/lib/schemas/list-commitments"
    );
    queries.length = 0;

    const result = await listCommitments({
      ...listCommitmentsRequestSchema.parse({
        userId,
        provenance: "trusted",
        statuses: ["pending", "in_progress"],
        limit: 200,
      }),
      accessScope: "workspace",
    });

    expect(result.commitments).toHaveLength(OPEN_TASKS);
    expect(result.nextCursor).toBeNull();
    expect(queries).toHaveLength(2);
    for (const commitment of result.commitments) {
      expect(commitment.dueOn).not.toBeNull();
      expect(commitment.presentation?.source).not.toBeNull();
      if (selfOwnedTaskIds.has(commitment.taskId)) {
        expect(commitment.owner).toBeNull();
      } else {
        expect(commitment.owner?.label).toMatch(/^Person \d+$/);
      }
    }
  });

  it("reads the open and candidate views in two queries each", async () => {
    const { getCandidateCommitments, getOpenCommitments } = await import(
      "./open-commitments"
    );
    queries.length = 0;
    const open = await getOpenCommitments({ userId, accessScope: "workspace" });
    expect(open).toHaveLength(OPEN_TASKS);
    expect(queries).toHaveLength(2);

    queries.length = 0;
    const candidates = await getCandidateCommitments({
      userId,
      accessScope: "workspace",
    });
    expect(candidates).toHaveLength(0);
    expect(queries).toHaveLength(2);
  });
});
