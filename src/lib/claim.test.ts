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

describeIfServer("claim operations", () => {
  const dbName = `memory_claim_test_${Date.now()}_${Math.floor(
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

  it("deletes once and reactivates the previous single-current claim", async () => {
    const userId = "user_A";
    const subjectNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    const priorClaimId = newTypeId("claim");
    const activeClaimId = newTypeId("claim");
    const priorAt = new Date("2026-04-01T00:00:00.000Z");
    const activeAt = new Date("2026-04-02T00:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await client.query(`
        CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "sources" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "type" varchar(50) NOT NULL,
          "external_id" text NOT NULL,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "status" varchar(20) DEFAULT 'completed',
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE "claims" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "subject_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_node_id" text REFERENCES "nodes"("id") ON DELETE CASCADE,
          "object_value" text,
          "predicate" varchar(80) NOT NULL,
          "statement" text NOT NULL,
          "description" text,
          "metadata" jsonb,
          "object_instant" timestamp with time zone,
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
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type")
           VALUES ($1, $2, 'Object')`,
        [subjectNodeId, userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_A', 'completed')`,
        [sourceId, userId],
      );
      await database.insert(schema.claims).values([
        {
          id: priorClaimId,
          userId,
          subjectNodeId,
          objectValue: "started",
          predicate: "HAS_STATUS",
          statement: "The project started.",
          sourceId,
          assertedByKind: "user",
          statedAt: priorAt,
          validFrom: priorAt,
          validTo: activeAt,
          status: "superseded",
        },
        {
          id: activeClaimId,
          userId,
          subjectNodeId,
          objectValue: "done",
          predicate: "HAS_STATUS",
          statement: "The project completed.",
          sourceId,
          assertedByKind: "user",
          statedAt: activeAt,
          validFrom: activeAt,
          status: "active",
        },
      ]);

      const { deleteClaim } = await import("./claim");
      await expect(deleteClaim(userId, activeClaimId)).resolves.toBe(true);
      await expect(deleteClaim(userId, activeClaimId)).resolves.toBe(false);

      const rows = await client.query<{
        id: string;
        status: string;
        valid_to: Date | null;
      }>(`SELECT id, status, valid_to FROM claims WHERE user_id = $1`, [
        userId,
      ]);

      expect(rows.rows).toEqual([
        {
          id: priorClaimId,
          status: "active",
          valid_to: null,
        },
      ]);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("persists metadata and objectInstant when provided", async () => {
    const userId = "user_meta";
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({
      useDatabase: async () => database,
    }));

    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS "users" ("id" text PRIMARY KEY NOT NULL);
        CREATE TABLE IF NOT EXISTS "nodes" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "node_type" varchar(50) NOT NULL,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE TABLE IF NOT EXISTS "sources" (
          "id" text PRIMARY KEY NOT NULL,
          "user_id" text NOT NULL REFERENCES "users"("id"),
          "type" varchar(50) NOT NULL,
          "external_id" text NOT NULL,
          "scope" varchar(16) DEFAULT 'personal' NOT NULL,
          "status" varchar(20) DEFAULT 'completed',
          "created_at" timestamp with time zone DEFAULT now() NOT NULL
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
          "object_instant" timestamp with time zone,
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
          CONSTRAINT "claims_object_shape_xor_ck2"
            CHECK (num_nonnulls("object_node_id", "object_value") = 1)
        );
        CREATE TABLE IF NOT EXISTS "node_metadata" (
          "id" text PRIMARY KEY NOT NULL,
          "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
          "label" text NOT NULL,
          "canonical_label" text NOT NULL
        );
      `);

      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_meta', 'completed')`,
        [sourceId, userId],
      );

      const { createClaim } = await import("./claim");
      const { setSkipEmbeddingPersistence } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      const subjectId = newTypeId("node");
      await client.query(
        `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Task')`,
        [subjectId, userId],
      );

      const objectId = newTypeId("node");
      await client.query(
        `INSERT INTO "nodes" ("id","user_id","node_type") VALUES ($1,$2,'Temporal')`,
        [objectId, userId],
      );

      const created = await createClaim({
        userId,
        subjectNodeId: subjectId,
        predicate: "DUE_ON",
        statement: "test due",
        objectNodeId: objectId,
        sourceId,
        metadata: { dueTime: "17:00", timeZone: "America/New_York" },
        objectInstant: new Date("2026-06-10T21:00:00.000Z"),
      });

      const { rows } = await client.query(
        `SELECT metadata, object_instant FROM claims WHERE id = $1`,
        [created.id],
      );
      expect(rows[0].metadata).toEqual({
        dueTime: "17:00",
        timeZone: "America/New_York",
      });
      expect(new Date(rows[0].object_instant).toISOString()).toBe(
        "2026-06-10T21:00:00.000Z",
      );
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});

describeIfServer("reattributeClaim", () => {
  const dbName = `memory_reattribute_test_${Date.now()}_${Math.floor(
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

  async function createSchema(client: Client): Promise<void> {
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
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
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
        "object_instant" timestamp with time zone,
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

  async function seedNode(
    client: Client,
    userId: string,
    nodeType: string,
    label: string,
  ): Promise<TypeId<"node">> {
    const nodeId = newTypeId("node");
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, $3)`,
      [nodeId, userId, nodeType],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
         VALUES ($1, $2, $3, $4)`,
      [newTypeId("node_metadata"), nodeId, label, label.toLowerCase()],
    );
    return nodeId;
  }

  function withDb(database: ReturnType<typeof drizzle>): void {
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
  }

  it("swaps the subject, retracts the original, preserves all other fields, and sets user_confirmed provenance", async () => {
    const userId = "user_subject";
    const sourceId = newTypeId("source");
    const statedAt = new Date("2026-05-01T00:00:00.000Z");
    const validFrom = new Date("2026-05-01T00:00:00.000Z");
    const validTo = new Date("2026-06-01T00:00:00.000Z");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    withDb(database);

    try {
      await createSchema(client);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_subject', 'completed')`,
        [sourceId, userId],
      );

      const oldSubjectId = await seedNode(client, userId, "Person", "Bob");
      const newSubjectId = await seedNode(client, userId, "Person", "Alice");
      const objectId = await seedNode(client, userId, "Object", "MacBook Pro");

      const { reattributeClaim } = await import("./claim");
      const { setSkipEmbeddingPersistence } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      const originalId = newTypeId("claim");
      await database.insert(schema.claims).values({
        id: originalId,
        userId,
        subjectNodeId: oldSubjectId,
        objectNodeId: objectId,
        predicate: "OWNS",
        statement: "Bob owns a MacBook Pro.",
        description: "ownership note",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt,
        validFrom,
        validTo,
        status: "active",
      });

      const result = await reattributeClaim({
        userId,
        claimId: originalId,
        replace: "subject",
        newNodeId: newSubjectId,
      });

      expect(result).not.toBeNull();
      expect(result!.id).not.toBe(originalId);
      // New endpoint swapped; everything else carried over verbatim.
      expect(result).toMatchObject({
        subjectNodeId: newSubjectId,
        objectNodeId: objectId,
        objectValue: null,
        predicate: "OWNS",
        statement: "Bob owns a MacBook Pro.",
        description: "ownership note",
        sourceId,
        scope: "personal",
        status: "active",
        assertedByKind: "user_confirmed",
        assertedByNodeId: newSubjectId,
        subjectLabel: "Alice",
        objectLabel: "MacBook Pro",
      });
      expect(result!.validFrom?.toISOString()).toBe(validFrom.toISOString());
      expect(result!.validTo?.toISOString()).toBe(validTo.toISOString());
      expect(result!.statedAt.toISOString()).toBe(statedAt.toISOString());

      // Original is retracted, not deleted — history must remain visible.
      const originalRow = await client.query<{ status: string }>(
        `SELECT status FROM claims WHERE id = $1`,
        [originalId],
      );
      expect(originalRow.rows).toHaveLength(1);
      expect(originalRow.rows[0]?.status).toBe("retracted");

      // Exactly two claims now exist: retracted original + active replacement.
      const all = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM claims WHERE user_id = $1`,
        [userId],
      );
      expect(all.rows[0]?.count).toBe("2");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("swaps the object endpoint for a relational claim", async () => {
    const userId = "user_object";
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    withDb(database);

    try {
      await createSchema(client);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_object', 'completed')`,
        [sourceId, userId],
      );

      const subjectId = await seedNode(client, userId, "Person", "Alice");
      const oldObjectId = await seedNode(
        client,
        userId,
        "Object",
        "Old laptop",
      );
      const newObjectId = await seedNode(
        client,
        userId,
        "Object",
        "New laptop",
      );

      const { reattributeClaim } = await import("./claim");
      const { setSkipEmbeddingPersistence } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      const originalId = newTypeId("claim");
      await database.insert(schema.claims).values({
        id: originalId,
        userId,
        subjectNodeId: subjectId,
        objectNodeId: oldObjectId,
        predicate: "OWNS",
        statement: "Alice owns a laptop.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-05-01T00:00:00.000Z"),
        status: "active",
      });

      const result = await reattributeClaim({
        userId,
        claimId: originalId,
        replace: "object",
        newNodeId: newObjectId,
      });

      expect(result).toMatchObject({
        subjectNodeId: subjectId,
        objectNodeId: newObjectId,
        assertedByKind: "user_confirmed",
        objectLabel: "New laptop",
      });
      // Object swap leaves the subject (and its provenance anchor) untouched.
      expect(result!.assertedByNodeId).toBeNull();
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("rejects object reattribution of an attribute claim", async () => {
    const userId = "user_attr";
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    withDb(database);

    try {
      await createSchema(client);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_attr', 'completed')`,
        [sourceId, userId],
      );

      const subjectId = await seedNode(client, userId, "Object", "Project");
      const otherNodeId = await seedNode(client, userId, "Concept", "Status");

      const { reattributeClaim, AttributeClaimObjectReattributionError } =
        await import("./claim");
      const { setSkipEmbeddingPersistence } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      const originalId = newTypeId("claim");
      await database.insert(schema.claims).values({
        id: originalId,
        userId,
        subjectNodeId: subjectId,
        objectValue: "done",
        predicate: "HAS_STATUS",
        statement: "The project is done.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-05-01T00:00:00.000Z"),
        status: "active",
      });

      await expect(
        reattributeClaim({
          userId,
          claimId: originalId,
          replace: "object",
          newNodeId: otherNodeId,
        }),
      ).rejects.toBeInstanceOf(AttributeClaimObjectReattributionError);

      // Nothing was retracted or created.
      const row = await client.query<{ status: string }>(
        `SELECT status FROM claims WHERE user_id = $1`,
        [userId],
      );
      expect(row.rows).toEqual([{ status: "active" }]);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("refuses a cross-scope reattribution", async () => {
    const userId = "user_scope";
    const personalSourceId = newTypeId("source");
    const referenceSourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    withDb(database);

    try {
      await createSchema(client);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'manual', 'manual:user_scope', 'personal', 'completed')`,
        [personalSourceId, userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
           VALUES ($1, $2, 'document', 'doc:user_scope', 'reference', 'completed')`,
        [referenceSourceId, userId],
      );

      const subjectId = await seedNode(client, userId, "Person", "Alice");
      const objectId = await seedNode(client, userId, "Object", "Laptop");
      // A reference-only node: its sole source link is reference-scoped, so its
      // effective scope is `reference`.
      const referenceNodeId = await seedNode(
        client,
        userId,
        "Concept",
        "Reference entity",
      );
      await client.query(
        `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES ($1, $2, $3)`,
        [newTypeId("source_link"), referenceSourceId, referenceNodeId],
      );

      const { reattributeClaim } = await import("./claim");
      const { CrossScopeMergeError } = await import("./node");
      const { setSkipEmbeddingPersistence } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      const originalId = newTypeId("claim");
      await database.insert(schema.claims).values({
        id: originalId,
        userId,
        subjectNodeId: subjectId,
        objectNodeId: objectId,
        predicate: "OWNS",
        statement: "Alice owns a laptop.",
        sourceId: personalSourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-05-01T00:00:00.000Z"),
        status: "active",
      });

      // Re-pointing the object at a reference-scoped node makes the (personal
      // subject, reference object) pair cross-scope.
      await expect(
        reattributeClaim({
          userId,
          claimId: originalId,
          replace: "object",
          newNodeId: referenceNodeId,
        }),
      ).rejects.toBeInstanceOf(CrossScopeMergeError);

      const row = await client.query<{ status: string }>(
        `SELECT status FROM claims WHERE user_id = $1`,
        [userId],
      );
      expect(row.rows).toEqual([{ status: "active" }]);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws NodesNotFoundError when the new node is missing", async () => {
    const userId = "user_missing_node";
    const sourceId = newTypeId("source");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    withDb(database);

    try {
      await createSchema(client);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
           VALUES ($1, $2, 'manual', 'manual:user_missing_node', 'completed')`,
        [sourceId, userId],
      );

      const subjectId = await seedNode(client, userId, "Person", "Alice");
      const objectId = await seedNode(client, userId, "Object", "Laptop");

      const { reattributeClaim, NodesNotFoundError } = await import("./claim");
      const { setSkipEmbeddingPersistence } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      const originalId = newTypeId("claim");
      await database.insert(schema.claims).values({
        id: originalId,
        userId,
        subjectNodeId: subjectId,
        objectNodeId: objectId,
        predicate: "OWNS",
        statement: "Alice owns a laptop.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-05-01T00:00:00.000Z"),
        status: "active",
      });

      await expect(
        reattributeClaim({
          userId,
          claimId: originalId,
          replace: "subject",
          newNodeId: newTypeId("node"),
        }),
      ).rejects.toBeInstanceOf(NodesNotFoundError);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("returns null when the claim does not exist", async () => {
    const userId = "user_missing_claim";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    withDb(database);

    try {
      await createSchema(client);
      await client.query(
        `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
        [userId],
      );
      const nodeId = await seedNode(client, userId, "Person", "Alice");

      const { reattributeClaim } = await import("./claim");

      await expect(
        reattributeClaim({
          userId,
          claimId: newTypeId("claim"),
          replace: "subject",
          newNodeId: nodeId,
        }),
      ).resolves.toBeNull();
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it.each(["retracted", "superseded", "contradicted"] as const)(
    "rejects reattribution of a %s (non-active) claim",
    async (status) => {
      const userId = `user_inactive_${status}`;
      const sourceId = newTypeId("source");

      const client = new Client({ connectionString: dsnFor(dbName) });
      await client.connect();
      const database = drizzle(client, { schema, casing: "snake_case" });
      withDb(database);

      try {
        await createSchema(client);
        await client.query(
          `INSERT INTO "users" ("id") VALUES ($1) ON CONFLICT DO NOTHING`,
          [userId],
        );
        await client.query(
          `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "status")
             VALUES ($1, $2, 'manual', $3, 'completed')`,
          [sourceId, userId, `manual:${userId}`],
        );

        const oldSubjectId = await seedNode(client, userId, "Person", "Bob");
        const newSubjectId = await seedNode(client, userId, "Person", "Alice");
        const objectId = await seedNode(client, userId, "Object", "Laptop");

        const { reattributeClaim, InactiveClaimReattributionError } =
          await import("./claim");
        const { setSkipEmbeddingPersistence } = await import(
          "~/utils/test-overrides"
        );
        setSkipEmbeddingPersistence(true);

        const originalId = newTypeId("claim");
        await database.insert(schema.claims).values({
          id: originalId,
          userId,
          subjectNodeId: oldSubjectId,
          objectNodeId: objectId,
          predicate: "OWNS",
          statement: "Bob owns a laptop.",
          sourceId,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-05-01T00:00:00.000Z"),
          status,
        });

        await expect(
          reattributeClaim({
            userId,
            claimId: originalId,
            replace: "subject",
            newNodeId: newSubjectId,
          }),
        ).rejects.toBeInstanceOf(InactiveClaimReattributionError);

        // No new claim was created and the original keeps its status — dead
        // history is not resurrected.
        const rows = await client.query<{ status: string }>(
          `SELECT status FROM claims WHERE user_id = $1`,
          [userId],
        );
        expect(rows.rows).toEqual([{ status }]);
      } finally {
        vi.doUnmock("~/utils/db");
        vi.resetModules();
        await client.end();
      }
    },
  );
});
