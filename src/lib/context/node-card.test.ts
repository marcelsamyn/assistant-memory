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
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT.toString()}/${TEST_DB_ADMIN_DB}`;
const dsnFor = (dbName: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT.toString()}/${dbName}`;

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

async function createCardTestTables(client: Client): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS "claims", "aliases", "source_links", "node_metadata", "nodes", "sources", "users" CASCADE;
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
      "status" varchar(20) DEFAULT 'completed',
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "deleted_at" timestamp with time zone,
      "content_type" varchar(100),
      "content_length" integer,
      CONSTRAINT "sources_user_type_external_unique"
        UNIQUE ("user_id", "type", "external_id")
    );
    CREATE TABLE "source_links" (
      "id" text PRIMARY KEY NOT NULL,
      "source_id" text NOT NULL REFERENCES "sources"("id") ON DELETE CASCADE,
      "node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "specific_location" text,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "source_links_source_node_unique" UNIQUE ("source_id", "node_id")
    );
    CREATE TABLE "aliases" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "alias_text" text NOT NULL,
      "normalized_alias_text" text NOT NULL,
      "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "aliases_user_normalized_canonical_unique"
        UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
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
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

function makeTestDb(client: Client) {
  return drizzle(client, { schema, casing: "snake_case" });
}

describeIfServer("getNodeCard", () => {
  const dbName = `memory_node_card_test_${Date.now().toString()}_${Math.floor(Math.random() * 1e6).toString()}`;
  let client: Client;
  let database: ReturnType<typeof makeTestDb>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = makeTestDb(client);

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));
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

  async function freshSchema(): Promise<void> {
    await createCardTestTables(client);
  }

  async function insertUser(userId: string): Promise<void> {
    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  }

  async function insertNode(
    nodeId: TypeId<"node">,
    userId: string,
    nodeType: schema.NodeSelect["nodeType"],
    label: string | null,
    description: string | null = null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, $3)`,
      [nodeId, userId, nodeType],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "description") VALUES ($1, $2, $3, $4)`,
      [newTypeId("node_metadata"), nodeId, label, description],
    );
  }

  async function insertPersonalSource(
    sourceId: TypeId<"source">,
    userId: string,
    externalId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status")
       VALUES ($1, $2, 'conversation_message', $3, 'personal', 'completed')`,
      [sourceId, userId, externalId],
    );
  }

  async function insertReferenceSource(
    sourceId: TypeId<"source">,
    userId: string,
    externalId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id", "scope", "status", "metadata", "last_ingested_at")
       VALUES ($1, $2, 'document', $3, 'reference', 'completed', $4::jsonb, now())`,
      [sourceId, userId, externalId, JSON.stringify(metadata)],
    );
  }

  async function linkSource(
    sourceId: TypeId<"source">,
    nodeId: TypeId<"node">,
  ): Promise<void> {
    await client.query(
      `INSERT INTO "source_links" ("id", "source_id", "node_id") VALUES ($1, $2, $3)`,
      [newTypeId("source_link"), sourceId, nodeId],
    );
  }

  it("Person happy path: filters lifecycle, kinds, and surfaces aliases + open commitments", async () => {
    await freshSchema();
    const userId = "user_person_card";
    const personId = newTypeId("node");
    const projectId = newTypeId("node");
    const taskId = newTypeId("node");
    const sourceId = newTypeId("source");
    await insertUser(userId);
    await insertPersonalSource(sourceId, userId, "msg_person");

    await insertNode(personId, userId, "Person", "Marcel", "old description");
    await insertNode(projectId, userId, "Concept", "Memory Layer");
    await insertNode(taskId, userId, "Task", "Write the spec");

    // Two aliases, including one matching canonical (should dedup).
    await client.query(
      `INSERT INTO "aliases" ("id", "user_id", "alias_text", "normalized_alias_text", "canonical_node_id")
       VALUES ($1, $5, 'M', 'm', $4),
              ($2, $5, 'Marcel S', 'marcel s', $4),
              ($3, $5, 'marcel', 'marcel', $4)`,
      [
        newTypeId("alias"),
        newTypeId("alias"),
        newTypeId("alias"),
        personId,
        userId,
      ],
    );

    await database.insert(schema.claims).values([
      // Active HAS_STATUS
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "active",
        predicate: "HAS_STATUS",
        statement: "Marcel is active.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-26T10:00:00Z"),
        status: "active",
      },
      // Superseded HAS_STATUS — must NOT appear in currentFacts.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "on_leave",
        predicate: "HAS_STATUS",
        statement: "Marcel was on leave.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-01T10:00:00Z"),
        status: "superseded",
      },
      // Two HAS_PREFERENCE — one user, one assistant_inferred (excluded).
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "concise",
        predicate: "HAS_PREFERENCE",
        statement: "Marcel prefers concise communication.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-20T10:00:00Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "vegetarian",
        predicate: "HAS_PREFERENCE",
        statement: "Assistant guessed vegetarian.",
        sourceId,
        scope: "personal",
        assertedByKind: "assistant_inferred",
        statedAt: new Date("2026-04-21T10:00:00Z"),
        status: "active",
      },
      // HAS_GOAL user_confirmed.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: personId,
        objectValue: "ship claims layer",
        predicate: "HAS_GOAL",
        statement: "Ship claims layer this quarter.",
        sourceId,
        scope: "personal",
        assertedByKind: "user_confirmed",
        statedAt: new Date("2026-04-22T10:00:00Z"),
        status: "active",
      },
      // OWNED_BY relationship: project owned by Marcel (multi_value on Concept).
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: projectId,
        objectNodeId: personId,
        predicate: "OWNED_BY",
        statement: "Memory Layer is owned by Marcel.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-15T10:00:00Z"),
        status: "active",
      },
      // Open commitment: Task owned by Marcel, status pending.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskId,
        objectNodeId: personId,
        predicate: "OWNED_BY",
        statement: "Task is owned by Marcel.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-25T10:00:00Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskId,
        objectValue: "pending",
        predicate: "HAS_TASK_STATUS",
        statement: "Task is pending.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-25T10:00:00Z"),
        status: "active",
      },
    ]);

    const { getNodeCard } = await import("./node-card");
    const card = await getNodeCard({ userId, nodeId: personId });

    expect(card).not.toBeNull();
    if (!card) throw new Error("expected card");
    expect(card.scope).toBe("personal");
    expect(card.label).toBe("Marcel");
    expect(card.summary).toBe("old description");

    // currentFacts: active HAS_STATUS only.
    expect(card.currentFacts.map((f) => f.objectValue)).toEqual(["active"]);
    expect(card.currentFacts[0]?.predicate).toBe("HAS_STATUS");

    // preferencesGoals: user pref + user_confirmed goal; no assistant_inferred.
    expect(
      card.preferencesGoals.map((p) => ({ p: p.predicate, v: p.objectValue })),
    ).toEqual(
      expect.arrayContaining([
        { p: "HAS_PREFERENCE", v: "concise" },
        { p: "HAS_GOAL", v: "ship claims layer" },
      ]),
    );
    expect(card.preferencesGoals.length).toBe(2);

    // openCommitments populated for Person.
    expect(card.openCommitments).toBeDefined();
    expect(card.openCommitments?.length).toBe(1);
    expect(card.openCommitments?.[0]?.taskId).toBe(taskId);

    // recentEvidence excludes assistant_inferred.
    const evidenceStatements = card.recentEvidence.map((e) => e.statement);
    expect(evidenceStatements).not.toContain("Assistant guessed vegetarian.");

    // aliases: canonical first, deduplicated against alias rows that match it.
    expect(card.aliases[0]).toBe("Marcel");
    expect(card.aliases).toContain("M");
    expect(card.aliases).toContain("Marcel S");
    // 'marcel' alias collapses with canonical 'Marcel' under case-insensitive dedup.
    expect(card.aliases.filter((a) => a.toLowerCase() === "marcel")).toEqual([
      "Marcel",
    ]);

    expect(card.reference).toBeUndefined();
  });

  it("Reference node: scope=reference, reference metadata populated, no open commitments", async () => {
    await freshSchema();
    const userId = "user_ref_card";
    const conceptId = newTypeId("node");
    const refSourceId = newTypeId("source");

    await insertUser(userId);
    await insertReferenceSource(refSourceId, userId, "book_meditations", {
      author: "Marcus Aurelius",
      title: "Meditations",
    });
    await insertNode(conceptId, userId, "Concept", "Stoicism");
    await linkSource(refSourceId, conceptId);

    // A reference-scope claim about the concept.
    await database.insert(schema.claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: conceptId,
      objectValue: "control what you can",
      predicate: "HAS_PREFERENCE",
      statement: "Stoicism teaches focus on what is in your control.",
      sourceId: refSourceId,
      scope: "reference",
      assertedByKind: "document_author",
      statedAt: new Date("2026-04-10T10:00:00Z"),
      status: "active",
    });

    const { getNodeCard } = await import("./node-card");
    const card = await getNodeCard({ userId, nodeId: conceptId });
    expect(card).not.toBeNull();
    if (!card) throw new Error("expected card");
    expect(card.scope).toBe("reference");
    expect(card.reference).toEqual({
      author: "Marcus Aurelius",
      title: "Meditations",
    });
    expect(card.openCommitments).toBeUndefined();
  });

  it("Non-Person node: openCommitments stays undefined even with related OWNED_BY commitments", async () => {
    await freshSchema();
    const userId = "user_concept_card";
    const conceptId = newTypeId("node");
    const taskId = newTypeId("node");
    const sourceId = newTypeId("source");
    await insertUser(userId);
    await insertPersonalSource(sourceId, userId, "msg_concept");
    await insertNode(conceptId, userId, "Concept", "Big Project");
    await insertNode(taskId, userId, "Task", "Subtask");

    await database.insert(schema.claims).values([
      // Task's owner is the Concept (unusual but exercises the filter).
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskId,
        objectNodeId: conceptId,
        predicate: "OWNED_BY",
        statement: "Subtask owned by Big Project.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-25T10:00:00Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskId,
        objectValue: "pending",
        predicate: "HAS_TASK_STATUS",
        statement: "Subtask pending.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-25T10:00:00Z"),
        status: "active",
      },
    ]);

    const { getNodeCard } = await import("./node-card");
    const card = await getNodeCard({ userId, nodeId: conceptId });
    expect(card).not.toBeNull();
    if (!card) throw new Error("expected card");
    expect(card.openCommitments).toBeUndefined();
  });

  it("Subject-type cardinality routing: OWNED_BY is multi_value on Concept, single on Task", async () => {
    await freshSchema();
    const userId = "user_routing";
    const conceptId = newTypeId("node");
    const taskId = newTypeId("node");
    const owner1 = newTypeId("node");
    const owner2 = newTypeId("node");
    const sourceId = newTypeId("source");
    await insertUser(userId);
    await insertPersonalSource(sourceId, userId, "msg_routing");

    await insertNode(conceptId, userId, "Concept", "Shared Initiative");
    await insertNode(taskId, userId, "Task", "Single-owner Task");
    await insertNode(owner1, userId, "Person", "Alice");
    await insertNode(owner2, userId, "Person", "Bob");

    await database.insert(schema.claims).values([
      // Concept has TWO active OWNED_BY (multi_value) — both stay active.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: conceptId,
        objectNodeId: owner1,
        predicate: "OWNED_BY",
        statement: "Shared Initiative owned by Alice.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-10T10:00:00Z"),
        status: "active",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: conceptId,
        objectNodeId: owner2,
        predicate: "OWNED_BY",
        statement: "Shared Initiative owned by Bob.",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-12T10:00:00Z"),
        status: "active",
      },
      // Task has TWO OWNED_BY: lifecycle would have superseded the older one.
      // We emulate the post-lifecycle state directly.
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskId,
        objectNodeId: owner1,
        predicate: "OWNED_BY",
        statement: "Task owned by Alice (older).",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-10T10:00:00Z"),
        status: "superseded",
      },
      {
        id: newTypeId("claim"),
        userId,
        subjectNodeId: taskId,
        objectNodeId: owner2,
        predicate: "OWNED_BY",
        statement: "Task owned by Bob (latest).",
        sourceId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-04-15T10:00:00Z"),
        status: "active",
      },
    ]);

    const { getNodeCard } = await import("./node-card");

    // Concept card: both OWNED_BY claims are active and surface in recentEvidence.
    const conceptCard = await getNodeCard({ userId, nodeId: conceptId });
    expect(conceptCard).not.toBeNull();
    if (!conceptCard) throw new Error("expected concept card");
    // Multi_value OWNED_BY → not in currentFacts.
    expect(conceptCard.currentFacts).toEqual([]);
    // Both OWNED_BY claims appear in recentEvidence.
    const conceptStatements = conceptCard.recentEvidence.map((e) => e.statement);
    expect(conceptStatements).toContain("Shared Initiative owned by Alice.");
    expect(conceptStatements).toContain("Shared Initiative owned by Bob.");

    // Task card: single-current-value override → currentFacts has exactly one (latest).
    const taskCard = await getNodeCard({ userId, nodeId: taskId });
    expect(taskCard).not.toBeNull();
    if (!taskCard) throw new Error("expected task card");
    expect(taskCard.currentFacts.length).toBe(1);
    expect(taskCard.currentFacts[0]?.predicate).toBe("OWNED_BY");
    expect(taskCard.currentFacts[0]?.objectNodeId).toBe(owner2);
    expect(taskCard.currentFacts[0]?.objectLabel).toBe("Bob");
  });

  it("Unknown node: returns null", async () => {
    await freshSchema();
    const userId = "user_unknown";
    await insertUser(userId);
    const { getNodeCard } = await import("./node-card");
    const card = await getNodeCard({
      userId,
      nodeId: newTypeId("node"),
    });
    expect(card).toBeNull();
  });
});
