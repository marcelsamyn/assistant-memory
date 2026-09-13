/**
 * DB-integration tests for `getUserSelfAliases` / `setUserSelfAliases`.
 *
 * Mirrors `cleanup-operations.test.ts`: real Postgres on the non-default
 * test port, hand-rolled DDL (no migrator). The migration idempotence
 * test re-applies `0013_user_profiles_metadata.sql` on a migrated DB and
 * asserts no-op shape.
 */
import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { getUserSelfAliases, setUserSelfAliases } from "~/lib/user-profile";
import {
  ensureUserSelfIdentityFromProfile,
  ensureUserSelfPersonNode,
} from "~/lib/user-self-identity";
import { installPartitionCompatibilityFixture } from "~/test/postgres/partition-compatibility-fixture";
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
  // `setUserSelfAliases` now calls `ensureUserSelfIdentity`, which touches the
  // node/alias tables, so they must exist here too. Truncating `users CASCADE`
  // in `afterEach` reaches these via their FKs.
  await client.query(`
    CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
    CREATE TABLE IF NOT EXISTS "user_profiles" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "content" text NOT NULL,
      "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
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
  await installPartitionCompatibilityFixture(client);
}

describeIfServer("user-profile self-aliases helpers", () => {
  const dbName = `memory_user_profile_test_${Date.now()}_${Math.floor(
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
  });

  afterAll(async () => {
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
    await rootClient.query(`TRUNCATE "user_profiles", "users" CASCADE`);
  });

  async function seedUser(userId: string): Promise<void> {
    await rootClient.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  }

  it("setUserSelfAliases creates user_profiles row when none exists", async () => {
    const userId = "user_create";
    await seedUser(userId);

    const result = await setUserSelfAliases(database, userId, ["Marcel", "MS"]);
    expect(result.aliases).toEqual(["Marcel", "MS"]);

    const rows = await rootClient.query<{
      content: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT "content", "metadata" FROM "user_profiles" WHERE "user_id" = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.content).toBe("");
    expect(rows.rows[0]?.metadata).toMatchObject({
      userSelfAliases: ["Marcel", "MS"],
    });
  });

  it("setUserSelfAliases updates only userSelfAliases, preserving other catchall metadata", async () => {
    const userId = "user_preserve";
    await seedUser(userId);

    // Seed an existing row that already carries an unrelated catchall key.
    await rootClient.query(
      `INSERT INTO "user_profiles" ("id", "user_id", "content", "metadata")
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        "user_profile_preserve_____",
        userId,
        "existing pinned content",
        JSON.stringify({
          userSelfAliases: ["old"],
          otherFlag: { keep: true },
        }),
      ],
    );

    const result = await setUserSelfAliases(database, userId, [
      "Marcel",
      "marcel@samyn.co",
    ]);
    expect(result.aliases).toEqual(["Marcel", "marcel@samyn.co"]);

    const rows = await rootClient.query<{
      content: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT "content", "metadata" FROM "user_profiles" WHERE "user_id" = $1`,
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.content).toBe("existing pinned content");
    expect(rows.rows[0]?.metadata).toMatchObject({
      userSelfAliases: ["Marcel", "marcel@samyn.co"],
      otherFlag: { keep: true },
    });
  });

  it("getUserSelfAliases returns [] when no row exists", async () => {
    const userId = "user_missing";
    await seedUser(userId);
    expect(await getUserSelfAliases(database, userId)).toEqual([]);
  });

  it("getUserSelfAliases parses persisted aliases", async () => {
    const userId = "user_persisted";
    await seedUser(userId);
    await setUserSelfAliases(database, userId, ["Marcel", "MS"]);
    expect(await getUserSelfAliases(database, userId)).toEqual([
      "Marcel",
      "MS",
    ]);
  });

  it("setUserSelfAliases rejects empty strings inside the array", async () => {
    const userId = "user_empty";
    await seedUser(userId);
    await expect(
      setUserSelfAliases(database, userId, ["Marcel", ""]),
    ).rejects.toThrow();
  });

  it("rolls back the profile when identity partition validation fails", async () => {
    const userId = "user_profile_partition_failure";
    await seedUser(userId);
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrated')`,
      [userId],
    );
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES ($1, 'room:inactive', 'quarantined')`,
      [userId],
    );

    await expect(
      setUserSelfAliases(
        database,
        userId,
        ["Marcel Samyn"],
        contextPartitionKeySchema.parse("room:inactive"),
      ),
    ).rejects.toMatchObject({ code: "PARTITION_UNAUTHORIZED" });

    const profileRows = await rootClient.query(
      `SELECT 1 FROM "user_profiles" WHERE "user_id" = $1`,
      [userId],
    );
    const identityRows = await rootClient.query(
      `SELECT 1 FROM "nodes" WHERE "user_id" = $1`,
      [userId],
    );
    expect(profileRows.rows).toHaveLength(0);
    expect(identityRows.rows).toHaveLength(0);
  });

  it("updates every active workspace self identity without touching inactive or foreign rows", async () => {
    const userId = "user_workspace_profile";
    const foreignUserId = "user_workspace_profile_foreign";
    const partitionA = contextPartitionKeySchema.parse("room:profile-a");
    const partitionB = contextPartitionKeySchema.parse("room:profile-b");
    const inactivePartition = contextPartitionKeySchema.parse(
      "room:profile-inactive",
    );
    const selfA = newTypeId("node");
    const selfB = newTypeId("node");
    const inactiveSelf = newTypeId("node");
    const foreignSelf = newTypeId("node");

    await seedUser(userId);
    await seedUser(foreignUserId);
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrated'), ($2, 'migrated')`,
      [userId, foreignUserId],
    );
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES
         ($1, $3, 'active'),
         ($1, $4, 'active'),
         ($1, $5, 'quarantined'),
         ($2, $3, 'active')`,
      [userId, foreignUserId, partitionA, partitionB, inactivePartition],
    );
    await rootClient.query(
      `INSERT INTO "nodes" ("id", "user_id", "partition_key", "node_type")
       VALUES
         ($1, $5, $7, 'Person'),
         ($2, $5, $8, 'Person'),
         ($3, $5, $9, 'Person'),
         ($4, $6, $7, 'Person')`,
      [
        selfA,
        selfB,
        inactiveSelf,
        foreignSelf,
        userId,
        foreignUserId,
        partitionA,
        partitionB,
        inactivePartition,
      ],
    );
    await rootClient.query(
      `INSERT INTO "node_metadata"
         ("id", "node_id", "label", "canonical_label", "additional_data")
       VALUES
         ($1, $5, 'Old A', 'old a', '{"isUserSelf":true}'::jsonb),
         ($2, $6, 'Old B', 'old b', '{"isUserSelf":true}'::jsonb),
         ($3, $7, 'Inactive Old', 'inactive old', '{"isUserSelf":true}'::jsonb),
         ($4, $8, 'Foreign Old', 'foreign old', '{"isUserSelf":true}'::jsonb)`,
      [
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        newTypeId("node_metadata"),
        selfA,
        selfB,
        inactiveSelf,
        foreignSelf,
      ],
    );
    await rootClient.query(
      `INSERT INTO "aliases"
         ("id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id", "partition_key")
       VALUES
         ($1, $5, 'Old A Alias', 'old a alias', $7, $9),
         ($2, $5, 'Old B Alias', 'old b alias', $8, $10),
         ($3, $5, 'Keep Inactive', 'keep inactive', $11, $12),
         ($4, $6, 'Keep Foreign', 'keep foreign', $13, $9)`,
      [
        newTypeId("alias"),
        newTypeId("alias"),
        newTypeId("alias"),
        newTypeId("alias"),
        userId,
        foreignUserId,
        selfA,
        selfB,
        partitionA,
        partitionB,
        inactiveSelf,
        inactivePartition,
        foreignSelf,
      ],
    );

    await setUserSelfAliases(
      database,
      userId,
      ["Marcel", "Marcel Samyn"],
      undefined,
      "workspace",
    );

    await expect(
      rootClient.query<{ partition_key: string; label: string }>(
        `SELECT n."partition_key", m."label"
           FROM "nodes" n
           INNER JOIN "node_metadata" m ON m."node_id" = n."id"
          WHERE n."user_id" = $1
            AND m."additional_data"->>'isUserSelf' = 'true'
          ORDER BY n."partition_key"`,
        [userId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { partition_key: partitionA, label: "Marcel Samyn" },
        { partition_key: partitionB, label: "Marcel Samyn" },
        { partition_key: inactivePartition, label: "Inactive Old" },
      ],
    });
    const activeAliasRows = await rootClient.query<{
      partition_key: string;
      normalized_alias_text: string;
    }>(
      `SELECT "partition_key", "normalized_alias_text"
         FROM "aliases"
        WHERE "user_id" = $1
          AND "canonical_node_id" IN ($2, $3)
        ORDER BY "partition_key", "normalized_alias_text"`,
      [userId, selfA, selfB],
    );
    expect(activeAliasRows.rows).toEqual([
      { partition_key: partitionA, normalized_alias_text: "marcel samyn" },
      { partition_key: partitionA, normalized_alias_text: "old a alias" },
      { partition_key: partitionB, normalized_alias_text: "marcel samyn" },
      { partition_key: partitionB, normalized_alias_text: "old b alias" },
    ]);
    await expect(
      rootClient.query<{ label: string; normalized_alias_text: string }>(
        `SELECT m."label", a."normalized_alias_text"
           FROM "nodes" n
           INNER JOIN "node_metadata" m ON m."node_id" = n."id"
           INNER JOIN "aliases" a ON a."canonical_node_id" = n."id"
          WHERE n."id" = $1`,
        [inactiveSelf],
      ),
    ).resolves.toMatchObject({
      rows: [{ label: "Inactive Old", normalized_alias_text: "keep inactive" }],
    });
    await expect(
      rootClient.query<{ label: string; normalized_alias_text: string }>(
        `SELECT m."label", a."normalized_alias_text"
           FROM "nodes" n
           INNER JOIN "node_metadata" m ON m."node_id" = n."id"
           INNER JOIN "aliases" a ON a."canonical_node_id" = n."id"
          WHERE n."id" = $1`,
        [foreignSelf],
      ),
    ).resolves.toMatchObject({
      rows: [{ label: "Foreign Old", normalized_alias_text: "keep foreign" }],
    });
    await expect(
      rootClient.query(
        `SELECT 1 FROM "memory_partitions"
          WHERE "user_id" = $1 AND "partition_key" = 'memory:personal'`,
        [userId],
      ),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("creates only a Memory personal self identity when workspace has none", async () => {
    const userId = "user_workspace_profile_personal";
    const partitionKey = contextPartitionKeySchema.parse("room:profile-only");
    await seedUser(userId);
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrated')`,
      [userId],
    );
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES ($1, $2, 'active')`,
      [userId, partitionKey],
    );

    await setUserSelfAliases(
      database,
      userId,
      ["Marcel Samyn"],
      undefined,
      "workspace",
    );

    const selfRows = await rootClient.query<{
      partition_key: string | null;
      label: string | null;
    }>(
      `SELECT n."partition_key", m."label"
         FROM "nodes" n
         INNER JOIN "node_metadata" m ON m."node_id" = n."id"
        WHERE n."user_id" = $1
          AND m."additional_data"->>'isUserSelf' = 'true'`,
      [userId],
    );
    expect(selfRows.rows).toEqual([
      { partition_key: "memory:personal", label: "Marcel Samyn" },
    ]);
  });

  it("updates every marked self node in one active partition", async () => {
    const userId = "user_duplicate_self_markers";
    const partitionKey = contextPartitionKeySchema.parse("room:duplicate");
    const selfA = newTypeId("node");
    const selfB = newTypeId("node");

    await seedUser(userId);
    await rootClient.query(
      `INSERT INTO "partition_migration_state" ("user_id", "state")
       VALUES ($1, 'migrated')`,
      [userId],
    );
    await rootClient.query(
      `INSERT INTO "memory_partitions" ("user_id", "partition_key", "status")
       VALUES ($1, $2, 'active')`,
      [userId, partitionKey],
    );
    await rootClient.query(
      `INSERT INTO "nodes" ("id", "user_id", "partition_key", "node_type")
       VALUES ($1, $3, $4, 'Person'), ($2, $3, $4, 'Person')`,
      [selfA, selfB, userId, partitionKey],
    );
    await rootClient.query(
      `INSERT INTO "node_metadata"
         ("id", "node_id", "label", "canonical_label", "additional_data")
       VALUES
         ($1, $3, 'Old A', 'old a', '{"isUserSelf":true}'::jsonb),
         ($2, $4, 'Old B', 'old b', '{"isUserSelf":true}'::jsonb)`,
      [newTypeId("node_metadata"), newTypeId("node_metadata"), selfA, selfB],
    );

    await setUserSelfAliases(
      database,
      userId,
      ["Marcel", "Marcel Samyn"],
      undefined,
      "workspace",
    );

    const metadataRows = await rootClient.query<{
      node_id: string;
      label: string;
    }>(
      `SELECT "node_id", "label"
         FROM "node_metadata"
        WHERE "node_id" IN ($1, $2)
        ORDER BY "node_id"`,
      [selfA, selfB],
    );
    expect(metadataRows.rows).toEqual(
      [
        { node_id: selfA, label: "Marcel Samyn" },
        { node_id: selfB, label: "Marcel Samyn" },
      ].sort((left, right) => left.node_id.localeCompare(right.node_id)),
    );

    const aliasRows = await rootClient.query<{
      canonical_node_id: string;
      normalized_alias_text: string;
    }>(
      `SELECT "canonical_node_id", "normalized_alias_text"
         FROM "aliases"
        WHERE "user_id" = $1
          AND "canonical_node_id" IN ($2, $3)
        ORDER BY "canonical_node_id", "normalized_alias_text"`,
      [userId, selfA, selfB],
    );
    expect(aliasRows.rows).toEqual(
      [
        { canonical_node_id: selfA, normalized_alias_text: "marcel samyn" },
        { canonical_node_id: selfB, normalized_alias_text: "marcel samyn" },
      ].sort((left, right) =>
        `${left.canonical_node_id}:${left.normalized_alias_text}`.localeCompare(
          `${right.canonical_node_id}:${right.normalized_alias_text}`,
        ),
      ),
    );
  });

  it("initializes a lazy self node from the current stored profile", async () => {
    const userId = "user_lazy_profile_aliases";
    await seedUser(userId);
    await rootClient.query(
      `INSERT INTO "user_profiles" ("id", "user_id", "content", "metadata")
       VALUES ($1, $2, '', $3::jsonb)`,
      [
        newTypeId("user_profile"),
        userId,
        JSON.stringify({ userSelfAliases: ["Marcel", "Marcel Samyn"] }),
      ],
    );

    const nodeId = await ensureUserSelfPersonNode(database, userId);
    const metadata = await rootClient.query<{ label: string }>(
      `SELECT "label" FROM "node_metadata" WHERE "node_id" = $1`,
      [nodeId],
    );
    expect(metadata.rows).toEqual([{ label: "Marcel Samyn" }]);
    const aliasRows = await rootClient.query<{
      normalized_alias_text: string;
    }>(
      `SELECT "normalized_alias_text"
         FROM "aliases"
        WHERE "canonical_node_id" = $1`,
      [nodeId],
    );
    expect(aliasRows.rows).toEqual([{ normalized_alias_text: "marcel samyn" }]);
  });

  it("serializes create-first and save-first identity races with a database barrier", async () => {
    const createFirstUser = "user_self_create_first";
    const saveFirstUser = "user_self_save_first";
    await seedUser(createFirstUser);
    await seedUser(saveFirstUser);

    const clientA = new Client({ connectionString: dsnFor(dbName) });
    const clientB = new Client({ connectionString: dsnFor(dbName) });
    await clientA.connect();
    await clientB.connect();
    const dbA = drizzle(clientA, { schema, casing: "snake_case" });
    const dbB = drizzle(clientB, { schema, casing: "snake_case" });

    const waitForAdvisoryWaiter = async (client: Client): Promise<void> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await client.query(
          `SELECT 1
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND NOT granted
              AND pid <> pg_backend_pid()
            LIMIT 1`,
        );
        if (waiting.rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        "identity advisory-lock waiter did not reach the barrier",
      );
    };

    const runRace = async (
      userId: string,
      first: () => Promise<unknown>,
      second: () => Promise<unknown>,
    ): Promise<void> => {
      const gate = new Client({ connectionString: dsnFor(dbName) });
      await gate.connect();
      try {
        await gate.query("BEGIN");
        await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `user_self_identity:${userId}`,
        ]);
        const firstPromise = first();
        await waitForAdvisoryWaiter(gate);
        const secondPromise = second();
        await waitForAdvisoryWaiter(gate);
        await gate.query("COMMIT");
        await Promise.all([firstPromise, secondPromise]);
      } finally {
        await gate.query("ROLLBACK").catch(() => undefined);
        await gate.end();
      }
    };

    try {
      await runRace(
        createFirstUser,
        () => ensureUserSelfPersonNode(dbA, createFirstUser),
        () => setUserSelfAliases(dbB, createFirstUser, ["Marcel Create First"]),
      );
      await runRace(
        saveFirstUser,
        () => setUserSelfAliases(dbA, saveFirstUser, ["Marcel Save First"]),
        () => ensureUserSelfPersonNode(dbB, saveFirstUser),
      );
    } finally {
      await clientA.end();
      await clientB.end();
    }

    const rows = await rootClient.query<{ user_id: string; label: string }>(
      `SELECT u."id" AS user_id, m."label"
         FROM "users" u
         INNER JOIN "nodes" n ON n."user_id" = u."id"
         INNER JOIN "node_metadata" m ON m."node_id" = n."id"
        WHERE u."id" IN ($1, $2)
          AND m."additional_data"->>'isUserSelf' = 'true'
        ORDER BY u."id"`,
      [createFirstUser, saveFirstUser],
    );
    expect(rows.rows).toEqual([
      { user_id: createFirstUser, label: "Marcel Create First" },
      { user_id: saveFirstUser, label: "Marcel Save First" },
    ]);
  });

  it("does not overwrite a newer profile after an ordinary stale read", async () => {
    const userId = "user_self_newer_profile";
    await seedUser(userId);
    await setUserSelfAliases(database, userId, ["Old Profile"]);
    const staleAliases = await getUserSelfAliases(database, userId);
    expect(staleAliases).toEqual(["Old Profile"]);

    const clientA = new Client({ connectionString: dsnFor(dbName) });
    const clientB = new Client({ connectionString: dsnFor(dbName) });
    const gate = new Client({ connectionString: dsnFor(dbName) });
    await clientA.connect();
    await clientB.connect();
    await gate.connect();
    const dbA = drizzle(clientA, { schema, casing: "snake_case" });
    const dbB = drizzle(clientB, { schema, casing: "snake_case" });
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `user_self_identity:${userId}`,
      ]);
      const savePromise = setUserSelfAliases(dbA, userId, ["New Profile"]);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await gate.query(
          `SELECT 1
             FROM pg_locks
            WHERE locktype = 'advisory'
              AND NOT granted
              AND pid <> pg_backend_pid()
            LIMIT 1`,
        );
        if (waiting.rows.length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const ordinaryPromise = ensureUserSelfIdentityFromProfile(dbB, userId);
      await gate.query("COMMIT");
      await Promise.all([savePromise, ordinaryPromise]);
    } finally {
      await gate.query("ROLLBACK").catch(() => undefined);
      await gate.end();
      await clientA.end();
      await clientB.end();
    }

    expect(await getUserSelfAliases(database, userId)).toEqual(["New Profile"]);
    await expect(
      rootClient.query<{ label: string }>(
        `SELECT m."label"
           FROM "nodes" n
           INNER JOIN "node_metadata" m ON m."node_id" = n."id"
          WHERE n."user_id" = $1
            AND m."additional_data"->>'isUserSelf' = 'true'`,
        [userId],
      ),
    ).resolves.toMatchObject({ rows: [{ label: "New Profile" }] });
  });
});

describeIfServer("migration 0013 (user_profiles.metadata) idempotence", () => {
  const dbName = `memory_user_profile_mig_test_${Date.now()}_${Math.floor(
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

  it("adds metadata column once and is a no-op on rerun", async () => {
    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    try {
      // Pre-migration shape: user_profiles WITHOUT `metadata`.
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "user_profiles" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "content" text NOT NULL,
          "last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);
      await installPartitionCompatibilityFixture(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ('user_mig')`);
      await client.query(
        `INSERT INTO "user_profiles" ("id", "user_id", "content")
         VALUES ('user_profile_premig________', 'user_mig', 'existing content')`,
      );

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const migrationSql = await fs.readFile(
        path.join(process.cwd(), "drizzle", "0013_user_profiles_metadata.sql"),
        "utf8",
      );
      const applyMigration = async () => {
        const statements = migrationSql
          .split("--> statement-breakpoint")
          .map((statement) => statement.trim())
          .filter((statement) => statement.length > 0);
        for (const statement of statements) {
          await client.query(statement);
        }
      };

      await client.query("BEGIN");
      await applyMigration();
      await client.query("COMMIT");

      // Pre-existing row defaulted to '{}'::jsonb.
      const afterFirst = await client.query<{
        content: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT "content", "metadata" FROM "user_profiles"
           WHERE "user_id" = 'user_mig'`,
      );
      expect(afterFirst.rows).toHaveLength(1);
      expect(afterFirst.rows[0]?.content).toBe("existing content");
      expect(afterFirst.rows[0]?.metadata).toEqual({});

      // Mutate metadata; the rerun must not clobber it.
      await client.query(
        `UPDATE "user_profiles"
            SET "metadata" = '{"userSelfAliases":["Marcel"]}'::jsonb
          WHERE "user_id" = 'user_mig'`,
      );

      await client.query("BEGIN");
      await applyMigration();
      await client.query("COMMIT");

      const afterSecond = await client.query<{
        metadata: Record<string, unknown>;
      }>(`SELECT "metadata" FROM "user_profiles" WHERE "user_id" = 'user_mig'`);
      expect(afterSecond.rows[0]?.metadata).toEqual({
        userSelfAliases: ["Marcel"],
      });

      // Column count check — exactly one `metadata` column.
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='user_profiles'
             AND column_name='metadata'`,
      );
      expect(columns.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
