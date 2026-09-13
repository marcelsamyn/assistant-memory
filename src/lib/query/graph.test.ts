import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { queryGraphRequestSchema } from "~/lib/schemas/query-graph";
import { newTypeId, type TypeId } from "~/types/typeid";

const host = process.env["TEST_PG_HOST"] ?? "localhost";
const port = Number(process.env["TEST_PG_PORT"] ?? 5431);
const user = process.env["TEST_PG_USER"] ?? "postgres";
const password = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const adminDb = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";
const dsnFor = (name: string): string =>
  `postgres://${user}:${password}@${host}:${port}/${name}`;

process.env["DATABASE_URL"] ??= dsnFor(adminDb);
process.env["JINA_API_KEY"] ??= "test";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost:9999";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";

let database: NodePgDatabase<typeof schema>;
vi.mock("~/utils/db", () => ({ useDatabase: async () => database }));

async function isServerReachable(): Promise<boolean> {
  const client = new Client({ connectionString: dsnFor(adminDb) });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

describeIfServer("bounded graph reads", () => {
  const dbName = `memory_graph_bounds_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const partitionKey = contextPartitionKeySchema.parse("graph:a");
  const otherPartition = contextPartitionKeySchema.parse("graph:b");
  const userId = "graph-partitioned";
  const legacyUserId = "graph-legacy";
  const sourceId = newTypeId("source");
  const legacySourceId = newTypeId("source");
  const ids = Array.from({ length: 205 }, () => newTypeId("node")).sort();
  const legacyIds = Array.from({ length: 105 }, () => newTypeId("node")).sort();
  const otherPartitionNodeId = newTypeId("node");
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: dsnFor(adminDb) });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });
    await database
      .insert(schema.users)
      .values([{ id: userId }, { id: legacyUserId }]);
    await database
      .insert(schema.partitionMigrationState)
      .values({ userId, state: "migrating" });
    await database.insert(schema.memoryPartitions).values([
      { userId, partitionKey },
      { userId, partitionKey: otherPartition },
    ]);

    for (const fixture of [
      { userId, partitionKey, sourceId, ids },
      {
        userId: legacyUserId,
        partitionKey: null,
        sourceId: legacySourceId,
        ids: legacyIds,
      },
    ]) {
      await database.insert(schema.sources).values({
        id: fixture.sourceId,
        userId: fixture.userId,
        partitionKey: fixture.partitionKey,
        type: "document",
        externalId: fixture.userId,
      });
      // Reverse insertion order so a missing ORDER BY cannot pass accidentally.
      await database.insert(schema.nodes).values(
        [...fixture.ids].reverse().map((id) => ({
          id,
          userId: fixture.userId,
          partitionKey: fixture.partitionKey,
          nodeType: "Person" as const,
        })),
      );
      await database.insert(schema.nodeMetadata).values(
        fixture.ids.map((id) => ({
          id: newTypeId("node_metadata"),
          nodeId: id,
          label: `Person ${id}`,
        })),
      );
      await database.insert(schema.sourceLinks).values(
        fixture.ids.map((nodeId) => ({
          id: newTypeId("source_link"),
          sourceId: fixture.sourceId,
          nodeId,
        })),
      );
    }

    const excludedNodes = [
      {
        id: newTypeId("node"),
        partitionKey,
        nodeType: "Concept" as const,
        label: "Concept",
      },
      {
        id: otherPartitionNodeId,
        partitionKey: otherPartition,
        nodeType: "Person" as const,
        label: "Other partition",
      },
      {
        id: newTypeId("node"),
        partitionKey,
        nodeType: "Person" as const,
        label: null,
      },
    ];
    await database.insert(schema.nodes).values(
      excludedNodes.map(({ id, partitionKey, nodeType }) => ({
        id,
        partitionKey,
        nodeType,
        userId,
      })),
    );
    await database.insert(schema.nodeMetadata).values(
      excludedNodes.map(({ id, label }) => ({
        id: newTypeId("node_metadata"),
        nodeId: id,
        label,
      })),
    );

    const addClaim = async (
      subjectNodeId: TypeId<"node">,
      objectNodeId: TypeId<"node">,
    ): Promise<void> => {
      await database.insert(schema.claims).values({
        id: newTypeId("claim"),
        userId,
        partitionKey,
        subjectNodeId,
        objectNodeId,
        predicate: "RELATED_TO",
        statement: "Linked",
        sourceId,
        assertedByKind: "user",
        statedAt: new Date("2026-01-01"),
      });
    };
    await addClaim(ids[0]!, ids[1]!);
    await addClaim(ids[0]!, ids[204]!);
  });

  afterAll(async () => {
    await client?.end();
    const admin = new Client({ connectionString: dsnFor(adminDb) });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  it("honors the default limit for legacy graphs", async () => {
    const { queryKnowledgeGraph } = await import("./graph");
    const result = await queryKnowledgeGraph(
      queryGraphRequestSchema.parse({ userId: legacyUserId }),
    );
    expect(result.nodes.map((node) => node.id)).toEqual(
      legacyIds.slice(0, 100),
    );
    expect(
      result.nodes.every((node) => node.sourceIds?.includes(legacySourceId)),
    ).toBe(true);
  });

  it("applies partition and type filters before the limit and keeps only internal edges", async () => {
    const { queryKnowledgeGraph } = await import("./graph");
    const params = queryGraphRequestSchema.parse({
      userId,
      partitionKey,
      maxNodes: 200,
      nodeTypes: ["Person"],
    });
    const result = await queryKnowledgeGraph(params);
    expect(result.nodes.map((node) => node.id)).toEqual(ids.slice(0, 200));
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ subject: ids[0], object: ids[1] });
    expect(
      result.nodes.every(
        (node) =>
          node.sourceIds?.length === 1 && node.sourceIds[0] === sourceId,
      ),
    ).toBe(true);
    expect((await queryKnowledgeGraph(params)).nodes).toEqual(result.nodes);
  });

  it("returns no claims when only one node is selected", async () => {
    const { queryKnowledgeGraph } = await import("./graph");
    const result = await queryKnowledgeGraph({
      userId,
      partitionKey,
      maxNodes: 1,
    });
    expect(result.nodes.map((node) => node.id)).toEqual([ids[0]]);
    expect(result.claims).toEqual([]);
  });

  it("combines active partitions only when workspace access is explicit", async () => {
    const { queryKnowledgeGraph } = await import("./graph");
    const workspace = await queryKnowledgeGraph({
      userId,
      accessScope: "workspace",
      maxNodes: ids.length + 1,
      nodeTypes: ["Person"],
    });

    expect(workspace.nodes.map((node) => node.id)).toEqual(
      [...ids, otherPartitionNodeId].sort(),
    );
    expect(workspace.claims).toHaveLength(2);
    expect(workspace.claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: ids[0],
          object: ids[1],
        }),
        expect.objectContaining({
          subject: ids[0],
          object: ids[204],
        }),
      ]),
    );

    await expect(
      queryKnowledgeGraph({
        userId,
        maxNodes: ids.length + 1,
        nodeTypes: ["Person"],
      }),
    ).rejects.toMatchObject({ code: "PARTITION_REQUIRED" });
  });

  it("returns empty results when filters match no nodes", async () => {
    const { queryKnowledgeGraph } = await import("./graph");
    expect(
      await queryKnowledgeGraph({
        userId,
        partitionKey,
        maxNodes: 200,
        nodeTypes: ["Temporal"],
      }),
    ).toEqual({ nodes: [], claims: [] });
  });
});
