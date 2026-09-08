import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import {
  memoryPartitions,
  nodeMetadata,
  nodes,
  sources,
  users,
} from "~/db/schema";
import { setPartitionMigrationState } from "~/lib/partition-migration";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { setPartitionMigrationStateRequestSchema } from "~/lib/schemas/partition";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

let database: NodePgDatabase<typeof schema>;

vi.mock("~/utils/db", () => ({ useDatabase: async () => database }));

const adminDsn = () =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (name: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${name}`;

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

const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

describeIfServer("public evidence partition isolation", () => {
  const dbName = `memory_public_partition_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const userId = "public-partition-user";
  const partitionA = contextPartitionKeySchema.parse("opaque:client-a");
  const partitionB = contextPartitionKeySchema.parse("opaque:client-b");
  const nodeA = newTypeId("node");
  const nodeB = newTypeId("node");
  const sourceA = newTypeId("source");
  const sourceB = newTypeId("source");
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });

    await database.insert(users).values({ id: userId });
    await setPartitionMigrationState(
      database,
      setPartitionMigrationStateRequestSchema.parse({
        userId,
        expectedState: "unmigrated",
        expectedVersion: 0,
        nextState: "migrating",
      }),
    );
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA },
      { userId, partitionKey: partitionB },
    ]);
    await database.insert(sources).values([
      {
        id: sourceA,
        userId,
        partitionKey: partitionA,
        type: "document",
        externalId: "client-a-source",
      },
      {
        id: sourceB,
        userId,
        partitionKey: partitionB,
        type: "document",
        externalId: "client-b-source",
      },
    ]);
    await database.insert(nodes).values([
      { id: nodeA, userId, partitionKey: partitionA, nodeType: "Person" },
      { id: nodeB, userId, partitionKey: partitionB, nodeType: "Person" },
    ]);
    await database.insert(nodeMetadata).values([
      {
        nodeId: nodeA,
        label: "Alex",
        canonicalLabel: "alex",
        description: "Client A's Alex",
      },
      {
        nodeId: nodeB,
        label: "Alex",
        canonicalLabel: "alex",
        description: "Client B's Alex",
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await client.end();
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("treats a known node id from another room as not found", async () => {
    const { getNodeById } = await import("~/lib/node");

    await expect(
      getNodeById(userId, nodeB, undefined, partitionA),
    ).resolves.toBeNull();
    await expect(
      getNodeById(userId, nodeA, undefined, partitionA),
    ).resolves.toMatchObject({
      node: { id: nodeA, description: "Client A's Alex" },
    });
  });

  it("scopes source inventory and same-name dedup to one room", async () => {
    const { listSourcesPage } = await import("~/lib/sources-read");
    const { runDedupSweep } = await import("~/lib/jobs/dedup-sweep");

    const page = await listSourcesPage({
      db: database,
      userId,
      partitionKey: partitionA,
      type: undefined,
      limit: 20,
      cursor: undefined,
    });
    expect(page.sources.map((source) => source.sourceId)).toEqual([sourceA]);

    await runDedupSweep(userId, database, partitionA);
    const survivingIds = await database.select({ id: nodes.id }).from(nodes);
    expect(survivingIds.map(({ id }) => id).sort()).toEqual(
      [nodeA, nodeB].sort(),
    );
  });
});
