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
process.env["JINA_API_KEY"] ??= "test";
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

describeIfServer("sampleInterestingNodes", () => {
  const dbName = `memory_sample_nodes_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;

  let client: Client;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let testIds: {
    hub: string;
    wellLinked: string;
    thin: string;
    noisy: string;
    unlabeled: string;
  };

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    await client.query(`
      CREATE TABLE "users" ("id" text PRIMARY KEY NOT NULL);
      CREATE TABLE "nodes" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "node_type" varchar(50) NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL
      );
      CREATE TABLE "node_metadata" (
        "id" text PRIMARY KEY NOT NULL,
        "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
        "label" text,
        "canonical_label" text,
        "description" text,
        "additional_data" jsonb,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "node_metadata_node_id_unique" UNIQUE ("node_id")
      );
      CREATE TABLE "sources" (
        "id" text PRIMARY KEY NOT NULL,
        "user_id" text NOT NULL REFERENCES "users"("id"),
        "type" varchar(50) NOT NULL,
        "external_id" text NOT NULL,
        "parent_source" text,
        "scope" varchar(16) DEFAULT 'personal' NOT NULL,
        "metadata" jsonb,
        "last_ingested_at" timestamp with time zone,
        "status" varchar(20) DEFAULT 'pending',
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "deleted_at" timestamp with time zone,
        "content_type" varchar(100),
        "content_length" integer
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
        "superseded_by_claim_id" text,
        "contradicted_by_claim_id" text,
        "stated_at" timestamp with time zone NOT NULL,
        "valid_from" timestamp with time zone,
        "valid_to" timestamp with time zone,
        "status" varchar(30) DEFAULT 'active' NOT NULL,
        "created_at" timestamp with time zone DEFAULT now() NOT NULL,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL
      );
    `);

    const userId = "user_sample";

    const hub = newTypeId("node"); // Concept, 4 connections -> included
    const wellLinked = newTypeId("node"); // Person, 3 connections -> included
    const thin = newTypeId("node"); // Person, 2 connections -> excluded
    const noisy = newTypeId("node"); // Temporal, 5 connections -> excluded (noise)
    const unlabeled = newTypeId("node"); // 4 connections but no label -> excluded
    const spokes = Array.from({ length: 5 }, () => newTypeId("node"));
    const src = newTypeId("source");

    // Store for assertions in the it blocks.
    testIds = { hub, wellLinked, thin, noisy, unlabeled };

    await database.insert(schema.users).values({ id: userId });
    await database.insert(schema.sources).values({
      id: src,
      userId,
      type: "conversation",
      externalId: "conv:1",
      scope: "personal",
      status: "completed",
    });

    const allNodes = [hub, wellLinked, thin, noisy, unlabeled, ...spokes];
    await database.insert(schema.nodes).values(
      allNodes.map((id) => ({
        id,
        userId,
        nodeType:
          id === hub
            ? ("Concept" as const)
            : id === noisy
              ? ("Temporal" as const)
              : ("Person" as const),
      })),
    );

    // Labels for everything except `unlabeled`.
    await database.insert(schema.nodeMetadata).values(
      [hub, wellLinked, thin, noisy, ...spokes].map((id) => ({
        id: newTypeId("node_metadata"),
        nodeId: id,
        label: `label-${id.slice(-4)}`,
        description: null,
      })),
    );
    await database.insert(schema.nodeMetadata).values({
      id: newTypeId("node_metadata"),
      nodeId: unlabeled,
      label: null,
      description: null,
    });

    // Helper: make `count` active claims linking `node` to distinct spokes.
    const linkClaims = (node: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: newTypeId("claim"),
        userId,
        subjectNodeId: node,
        objectNodeId: spokes[i % spokes.length]!,
        predicate: "RELATED_TO",
        statement: "x",
        sourceId: src,
        scope: "personal" as const,
        assertedByKind: "user_stated" as const,
        statedAt: new Date("2026-01-01T00:00:00.000Z"),
        status: "active" as const,
      }));

    await database
      .insert(schema.claims)
      .values([
        ...linkClaims(hub, 4),
        ...linkClaims(wellLinked, 3),
        ...linkClaims(thin, 2),
        ...linkClaims(noisy, 5),
        ...linkClaims(unlabeled, 4),
      ]);
  });

  afterAll(async () => {
    vi.doUnmock("~/utils/db");
    vi.resetModules();
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

  it("returns only labeled, non-noise nodes with >= 3 connections", async () => {
    const userId = "user_sample";
    const { hub, wellLinked, thin, noisy, unlabeled } = testIds;

    const { sampleInterestingNodes } = await import("./sample-nodes");
    const result = await sampleInterestingNodes({ userId, limit: 6 });

    const ids = result.nodes.map((n) => n.id);
    expect(ids).toContain(hub);
    expect(ids).toContain(wellLinked);
    expect(ids).not.toContain(thin);
    expect(ids).not.toContain(noisy);
    expect(ids).not.toContain(unlabeled);
    result.nodes.forEach((n) => {
      expect(n.connectionCount).toBeGreaterThanOrEqual(3);
      expect(n.label.length).toBeGreaterThan(0);
    });
  });

  it("respects the nodeTypes filter and the limit", async () => {
    const { sampleInterestingNodes } = await import("./sample-nodes");
    const result = await sampleInterestingNodes({
      userId: "user_sample",
      limit: 1,
      nodeTypes: ["Concept"],
    });
    expect(result.nodes.length).toBe(1);
    result.nodes.forEach((n) => expect(n.nodeType).toBe("Concept"));
  });

  it("returns an empty array when no node qualifies", async () => {
    const { sampleInterestingNodes } = await import("./sample-nodes");
    const result = await sampleInterestingNodes({
      userId: "user_nobody",
      limit: 6,
    });
    expect(result.nodes).toEqual([]);
  });
});
