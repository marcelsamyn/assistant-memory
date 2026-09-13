import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { memoryPartitions, nodes, nodeMetadata, users } from "~/db/schema";
import {
  ensurePersonalPartition,
  partitionAccessCondition,
} from "~/lib/partition-access";
import {
  contextPartitionKeySchema,
  MEMORY_PERSONAL_PARTITION_KEY,
} from "~/lib/schemas/partition";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

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

describeIfServer("workspace partition access", () => {
  const dbName = `memory_workspace_access_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const userId = "workspace-access-user";
  const otherUserId = "workspace-access-other";
  const legacyUserId = "workspace-access-legacy";
  const migratingUserId = "workspace-access-migrating";
  const partitionA = contextPartitionKeySchema.parse("room:a");
  const partitionB = contextPartitionKeySchema.parse("room:b");
  const quarantined = contextPartitionKeySchema.parse("room:quarantined");
  let client: Client;
  let database: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    await migrate(database, { migrationsFolder: "./drizzle" });

    await database.insert(users).values([
      { id: userId },
      { id: otherUserId },
      { id: legacyUserId },
      { id: migratingUserId },
    ]);
    await database.insert(memoryPartitions).values([
      { userId, partitionKey: partitionA, status: "active" },
      { userId, partitionKey: partitionB, status: "active" },
      { userId, partitionKey: quarantined, status: "quarantined" },
      { userId: otherUserId, partitionKey: partitionA, status: "active" },
    ]);
    await database.insert(schema.partitionMigrationState).values({
      userId,
      state: "migrated",
      version: 1,
    });
    await database.insert(schema.partitionMigrationState).values({
      userId: otherUserId,
      state: "migrated",
      version: 1,
    });
    await database.insert(schema.partitionMigrationState).values({
      userId: migratingUserId,
      state: "migrating",
      version: 1,
    });

    const rows = [
      { userId, partitionKey: partitionA, label: "A" },
      { userId, partitionKey: partitionB, label: "B" },
      { userId: otherUserId, partitionKey: partitionA, label: "other" },
      { userId: legacyUserId, partitionKey: null, label: "legacy" },
    ];
    for (const row of rows) {
      const nodeId = newTypeId("node");
      await database.insert(nodes).values({
        id: nodeId,
        userId: row.userId,
        partitionKey: row.partitionKey ?? undefined,
        nodeType: "Person",
      });
      await database.insert(nodeMetadata).values({
        id: newTypeId("node_metadata"),
        nodeId,
        label: row.label,
        canonicalLabel: row.label.toLowerCase(),
      });
    }
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

  it("returns only active partitions for the requested user", async () => {
    const rows = await database
      .select({ userId: nodes.userId, label: nodeMetadata.label })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            undefined,
            "workspace",
          ),
        ),
      )
      .orderBy(nodeMetadata.label);

    expect(rows).toEqual([
      { userId, label: "A" },
      { userId, label: "B" },
    ]);

    await expect(
      database
        .select({ label: nodeMetadata.label })
        .from(nodes)
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(
            eq(nodes.userId, legacyUserId),
            partitionAccessCondition(
              nodes.partitionKey,
              legacyUserId,
              undefined,
              "workspace",
            ),
          ),
        ),
    ).resolves.toEqual([{ label: "legacy" }]);
  });

  it("does not broaden an explicit partition or strict legacy call", async () => {
    const scoped = await database
      .select({ label: nodeMetadata.label })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          partitionAccessCondition(
            nodes.partitionKey,
            userId,
            partitionA,
            "workspace",
          ),
        ),
      );
    expect(scoped).toEqual([{ label: "A" }]);

    const strict = await database
      .select({ label: nodeMetadata.label })
      .from(nodes)
      .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
      .where(
        and(
          eq(nodes.userId, userId),
          partitionAccessCondition(nodes.partitionKey, userId, undefined),
        ),
      );
    expect(strict).toEqual([]);
  });

  it("creates the Memory-owned personal destination only for migrated users", async () => {
    await expect(ensurePersonalPartition(database, userId)).resolves.toBe(
      "memory:personal",
    );
    await expect(
      database
        .select({ status: memoryPartitions.status })
        .from(memoryPartitions)
        .where(
          and(
            eq(memoryPartitions.userId, userId),
            eq(memoryPartitions.partitionKey, MEMORY_PERSONAL_PARTITION_KEY),
          ),
        ),
    ).resolves.toEqual([{ status: "active" }]);

    await expect(ensurePersonalPartition(database, legacyUserId)).resolves.toBe(
      undefined,
    );
    await expect(
      ensurePersonalPartition(database, migratingUserId),
    ).resolves.toBe(undefined);
  });
});
