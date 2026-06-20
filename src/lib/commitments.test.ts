import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { createCommitmentRequestSchema } from "~/lib/schemas/create-commitment";
import { setCommitmentDueRequestSchema } from "~/lib/schemas/set-commitment-due";
import { setCommitmentOwnerRequestSchema } from "~/lib/schemas/set-commitment-owner";
import { setCommitmentStatusRequestSchema } from "~/lib/schemas/set-commitment-status";
import { updateCommitmentRequestSchema } from "~/lib/schemas/update-commitment";
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
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "https://api.openai.com/v1";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test-model";
process.env["REDIS_URL"] ??= "redis://localhost:6380";
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

/**
 * Provision the minimal table set `createCommitment` exercises end-to-end:
 * `createNode` (nodes/metadata/sources/source_links + today's day node),
 * `createClaim` + lifecycle (claims), and the `getOpenCommitments` read model.
 * Embedding tables are intentionally omitted — the test flips on the
 * skip-embedding-persistence seam so no embedding rows are written.
 */
async function provisionSchema(client: Client): Promise<void> {
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
      "parent_source" text,
      "metadata" jsonb,
      "last_ingested_at" timestamp with time zone,
      "deleted_at" timestamp with time zone,
      "content_type" varchar(100),
      "content_length" integer,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "sources_user_type_external_unique"
        UNIQUE ("user_id", "type", "external_id")
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
    CREATE TABLE IF NOT EXISTS "aliases" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "users"("id"),
      "alias_text" text NOT NULL,
      "normalized_alias_text" text NOT NULL,
      "canonical_node_id" text NOT NULL REFERENCES "nodes"("id") ON DELETE CASCADE,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "aliases_user_normalized_canonical_unique" UNIQUE ("user_id", "normalized_alias_text", "canonical_node_id")
    );
  `);
}

describeIfServer("createCommitment", () => {
  const dbName = `memory_create_commitment_test_${Date.now()}_${Math.floor(
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

  it("opens a pending commitment that surfaces in the open-commitments view", async () => {
    const userId = "user_create_commitment_min";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment } = await import("./commitments");
        const { getOpenCommitments } = await import("./query/open-commitments");

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Send the spec",
          }),
        );

        expect(created).toMatchObject({
          label: "Send the spec",
          status: "pending",
          dueOn: null,
          owner: null,
          dueClaimId: null,
          ownerClaimId: null,
        });
        expect(created.taskId).toBeTruthy();
        expect(created.statusClaimId).toBeTruthy();

        const commitments = await getOpenCommitments({ userId });
        expect(commitments).toHaveLength(1);
        expect(commitments[0]).toMatchObject({
          taskId: created.taskId,
          label: "Send the spec",
          status: "pending",
          owner: null,
          dueOn: null,
        });
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("opens an in_progress commitment with a due date and owner", async () => {
    const userId = "user_create_commitment_full";
    const ownerNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [ownerNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
           VALUES ($1, $2, 'Marcel', 'marcel')`,
        [newTypeId("node_metadata"), ownerNodeId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment } = await import("./commitments");
        const { getOpenCommitments } = await import("./query/open-commitments");

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Review the memo",
            status: "in_progress",
            dueOn: "2026-07-15",
            ownedBy: ownerNodeId,
          }),
        );

        expect(created).toMatchObject({
          label: "Review the memo",
          status: "in_progress",
          dueOn: "2026-07-15",
          owner: { nodeId: ownerNodeId, label: "Marcel" },
        });
        expect(created.dueClaimId).toBeTruthy();
        expect(created.ownerClaimId).toBeTruthy();

        const commitments = await getOpenCommitments({ userId });
        expect(commitments).toHaveLength(1);
        expect(commitments[0]).toMatchObject({
          taskId: created.taskId,
          label: "Review the memo",
          status: "in_progress",
          owner: { nodeId: ownerNodeId, label: "Marcel" },
          dueOn: "2026-07-15",
        });
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});

describeIfServer("setCommitmentStatus", () => {
  const dbName = `memory_set_status_test_${Date.now()}_${Math.floor(
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

  it("marks a pending task done: supersedes prior claim, echoes previous status", async () => {
    const userId = "user_set_status_done";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, setCommitmentStatus } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Task to mark done",
          }),
        );
        const priorClaimId = created.statusClaimId;

        const result = await setCommitmentStatus(
          setCommitmentStatusRequestSchema.parse({
            userId,
            taskId: created.taskId,
            status: "done",
          }),
        );

        expect(result.taskId).toBe(created.taskId);
        expect(result.status).toBe("done");
        expect(result.claimId).toBeTruthy();
        expect(result.claimId).not.toBe(priorClaimId);
        expect(result.previousStatus).toBe("pending");
        expect(result.previousClaimId).toBe(priorClaimId);

        // The old claim must now be superseded
        const { rows } = await client.query(
          `SELECT status FROM claims WHERE id = $1`,
          [priorClaimId],
        );
        expect(rows[0]?.status).toBe("superseded");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("returns null previousStatus/previousClaimId when no prior active status exists", async () => {
    const userId = "user_set_status_noprev";
    const taskNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      // Insert a bare Task node with no claims
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Task')`,
        [taskNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'No-prior task', 'no-prior task')`,
        [newTypeId("node_metadata"), taskNodeId],
      );
      // We need a source for the claim to be created
      const sourceId = newTypeId("source");
      await client.query(
        `INSERT INTO "sources" ("id", "user_id", "type", "external_id") VALUES ($1, $2, 'manual', $3)`,
        [sourceId, userId, `manual:${userId}`],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { setCommitmentStatus } = await import("./commitments");

        const result = await setCommitmentStatus(
          setCommitmentStatusRequestSchema.parse({
            userId,
            taskId: taskNodeId,
            status: "in_progress",
          }),
        );

        expect(result.previousStatus).toBeNull();
        expect(result.previousClaimId).toBeNull();
        expect(result.status).toBe("in_progress");
        expect(result.claimId).toBeTruthy();
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("accepts all four status values", async () => {
    const userId = "user_set_status_all4";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, setCommitmentStatus } = await import(
          "./commitments"
        );

        const statuses = [
          "pending",
          "in_progress",
          "done",
          "abandoned",
        ] as const;
        for (const status of statuses) {
          const created = await createCommitment(
            createCommitmentRequestSchema.parse({
              userId,
              label: `Task for ${status}`,
            }),
          );
          const result = await setCommitmentStatus(
            setCommitmentStatusRequestSchema.parse({
              userId,
              taskId: created.taskId,
              status,
            }),
          );
          expect(result.status).toBe(status);
        }
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws TaskNotFoundError for a non-Task node", async () => {
    const userId = "user_set_status_nontask";
    const personNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [personNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'Some person', 'some person')`,
        [newTypeId("node_metadata"), personNodeId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { setCommitmentStatus, TaskNotFoundError } = await import(
          "./commitments"
        );

        await expect(
          setCommitmentStatus(
            setCommitmentStatusRequestSchema.parse({
              userId,
              taskId: personNodeId,
              status: "done",
            }),
          ),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});

describeIfServer("setCommitmentOwner", () => {
  const dbName = `memory_set_owner_test_${Date.now()}_${Math.floor(
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

  it("assigns an owner and then reassigns, superseding the prior ASSIGNED_TO", async () => {
    const userId = "user_set_owner_reassign";
    const ownerANodeId = newTypeId("node");
    const ownerBNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person'), ($3, $2, 'Person')`,
        [ownerANodeId, userId, ownerBNodeId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
         VALUES ($1, $3, 'Alice', 'alice'), ($2, $4, 'Bob', 'bob')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          ownerANodeId,
          ownerBNodeId,
        ],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, setCommitmentOwner } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Task with owner",
          }),
        );

        // Assign owner A
        const assignResult = await setCommitmentOwner(
          setCommitmentOwnerRequestSchema.parse({
            userId,
            taskId: created.taskId,
            ownedBy: ownerANodeId,
          }),
        );
        expect(assignResult.owner).toMatchObject({
          nodeId: ownerANodeId,
          label: "Alice",
        });
        expect(assignResult.claimId).toBeTruthy();
        const firstOwnerClaimId = assignResult.claimId!;

        // Reassign to owner B — should supersede the previous ASSIGNED_TO
        const reassignResult = await setCommitmentOwner(
          setCommitmentOwnerRequestSchema.parse({
            userId,
            taskId: created.taskId,
            ownedBy: ownerBNodeId,
          }),
        );
        expect(reassignResult.owner).toMatchObject({
          nodeId: ownerBNodeId,
          label: "Bob",
        });
        expect(reassignResult.claimId).toBeTruthy();
        expect(reassignResult.claimId).not.toBe(firstOwnerClaimId);

        // Prior ASSIGNED_TO claim must be superseded
        const { rows } = await client.query(
          `SELECT status FROM claims WHERE id = $1`,
          [firstOwnerClaimId],
        );
        expect(rows[0]?.status).toBe("superseded");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("clears an owner (ownedBy: null) retracts active ASSIGNED_TO and returns retractedClaimIds", async () => {
    const userId = "user_set_owner_clear";
    const ownerNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [ownerNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'Charlie', 'charlie')`,
        [newTypeId("node_metadata"), ownerNodeId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, setCommitmentOwner } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Task to unown",
            ownedBy: ownerNodeId,
          }),
        );
        const ownerClaimId = created.ownerClaimId!;
        expect(ownerClaimId).toBeTruthy();

        // Clear owner
        const clearResult = await setCommitmentOwner(
          setCommitmentOwnerRequestSchema.parse({
            userId,
            taskId: created.taskId,
            ownedBy: null,
          }),
        );

        expect(clearResult.owner).toBeNull();
        expect(clearResult.claimId).toBeNull();
        expect(clearResult.retractedClaimIds).toContain(ownerClaimId);

        // The ASSIGNED_TO claim must now be retracted
        const { rows } = await client.query(
          `SELECT status FROM claims WHERE id = $1`,
          [ownerClaimId],
        );
        expect(rows[0]?.status).toBe("retracted");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws NodesNotFoundError when ownedBy refers to an unknown node", async () => {
    const userId = "user_set_owner_badowner";
    const unknownNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, setCommitmentOwner } = await import(
          "./commitments"
        );
        const { NodesNotFoundError } = await import("~/lib/claim");

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Task bad owner",
          }),
        );

        await expect(
          setCommitmentOwner(
            setCommitmentOwnerRequestSchema.parse({
              userId,
              taskId: created.taskId,
              ownedBy: unknownNodeId,
            }),
          ),
        ).rejects.toBeInstanceOf(NodesNotFoundError);
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws TaskNotFoundError for a non-Task subject", async () => {
    const userId = "user_set_owner_nontask";
    const personNodeId = newTypeId("node");
    const ownerNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person'), ($3, $2, 'Person')`,
        [personNodeId, userId, ownerNodeId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label")
         VALUES ($1, $3, 'Not a task', 'not a task'), ($2, $4, 'Owner', 'owner')`,
        [
          newTypeId("node_metadata"),
          newTypeId("node_metadata"),
          personNodeId,
          ownerNodeId,
        ],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { setCommitmentOwner, TaskNotFoundError } = await import(
          "./commitments"
        );

        await expect(
          setCommitmentOwner(
            setCommitmentOwnerRequestSchema.parse({
              userId,
              taskId: personNodeId,
              ownedBy: ownerNodeId,
            }),
          ),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});

describeIfServer("updateCommitment", () => {
  const dbName = `memory_update_commitment_test_${Date.now()}_${Math.floor(
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

  it("updates label only", async () => {
    const userId = "user_update_label_only";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, updateCommitment } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Original label",
          }),
        );

        const updated = await updateCommitment(
          updateCommitmentRequestSchema.parse({
            userId,
            taskId: created.taskId,
            label: "New label",
          }),
        );

        expect(updated.taskId).toBe(created.taskId);
        expect(updated.label).toBe("New label");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("updates description only", async () => {
    const userId = "user_update_desc_only";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, updateCommitment } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Task with description",
          }),
        );

        const updated = await updateCommitment(
          updateCommitmentRequestSchema.parse({
            userId,
            taskId: created.taskId,
            description: "My description",
          }),
        );

        expect(updated.taskId).toBe(created.taskId);
        expect(updated.description).toBe("My description");
        // label unchanged
        expect(updated.label).toBe("Task with description");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("clears the description to null when given an empty string", async () => {
    const userId = "user_update_desc_clear";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, updateCommitment } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Task to clear",
            description: "Initial description",
          }),
        );

        const cleared = await updateCommitment(
          updateCommitmentRequestSchema.parse({
            userId,
            taskId: created.taskId,
            description: "",
          }),
        );

        // An empty string clears to null, not a stored "".
        expect(cleared.description).toBeNull();

        const persisted = await client.query(
          `SELECT description FROM node_metadata WHERE node_id = $1`,
          [created.taskId],
        );
        expect(persisted.rows[0].description).toBeNull();
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("updates both label and description", async () => {
    const userId = "user_update_both";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, updateCommitment } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Label before",
            description: "Desc before",
          }),
        );

        const updated = await updateCommitment(
          updateCommitmentRequestSchema.parse({
            userId,
            taskId: created.taskId,
            label: "Label after",
            description: "Desc after",
          }),
        );

        expect(updated.label).toBe("Label after");
        expect(updated.description).toBe("Desc after");
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws TaskNotFoundError for a non-Task subject", async () => {
    const userId = "user_update_nontask";
    const personNodeId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
      await client.query(
        `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Person')`,
        [personNodeId, userId],
      );
      await client.query(
        `INSERT INTO "node_metadata" ("id", "node_id", "label", "canonical_label") VALUES ($1, $2, 'Not a task', 'not a task')`,
        [newTypeId("node_metadata"), personNodeId],
      );

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { updateCommitment, TaskNotFoundError } = await import(
          "./commitments"
        );

        await expect(
          updateCommitment(
            updateCommitmentRequestSchema.parse({
              userId,
              taskId: personNodeId,
              label: "Should fail",
            }),
          ),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("throws TaskNotFoundError for an unknown taskId", async () => {
    const userId = "user_update_unknown";
    const unknownTaskId = newTypeId("node");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { updateCommitment, TaskNotFoundError } = await import(
          "./commitments"
        );

        await expect(
          updateCommitment(
            updateCommitmentRequestSchema.parse({
              userId,
              taskId: unknownTaskId,
              label: "Should fail",
            }),
          ),
        ).rejects.toBeInstanceOf(TaskNotFoundError);
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});

describeIfServer("commitment due time", () => {
  const dbName = `memory_due_time_test_${Date.now()}_${Math.floor(
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

  it("createCommitment stores dueTime + timeZone + object_instant and echoes them", async () => {
    const userId = "user_due_time_create";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment } = await import("./commitments");

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Call the bank",
            dueOn: "2026-06-10",
            dueTime: "17:00",
            timeZone: "America/New_York",
          }),
        );
        expect(created.dueOn).toBe("2026-06-10");
        expect(created.dueTime).toBe("17:00");
        expect(created.timeZone).toBe("America/New_York");
        expect(created.dueAt?.toISOString()).toBe("2026-06-10T21:00:00.000Z"); // 17:00 EDT = 21:00Z

        const { rows } = await client.query(
          `SELECT metadata, object_instant FROM claims WHERE id = $1`,
          [created.dueClaimId],
        );
        expect(rows[0].metadata).toEqual({
          dueTime: "17:00",
          timeZone: "America/New_York",
        });
        expect(new Date(rows[0].object_instant).toISOString()).toBe(
          "2026-06-10T21:00:00.000Z",
        );
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("setCommitmentDue sets a time, then a date-only call clears it", async () => {
    const userId = "user_due_time_set";

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await provisionSchema(client);
      await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);

      const { setSkipEmbeddingPersistence, resetTestOverrides } = await import(
        "~/utils/test-overrides"
      );
      setSkipEmbeddingPersistence(true);

      try {
        const { createCommitment, setCommitmentDue } = await import(
          "./commitments"
        );

        const created = await createCommitment(
          createCommitmentRequestSchema.parse({
            userId,
            label: "Ship it",
            dueOn: "2026-06-10",
          }),
        );

        const timed = await setCommitmentDue(
          setCommitmentDueRequestSchema.parse({
            userId,
            taskId: created.taskId,
            dueOn: "2026-06-10",
            dueTime: "09:30",
            timeZone: "Europe/Paris",
          }),
        );
        expect(timed.dueTime).toBe("09:30");
        expect(timed.timeZone).toBe("Europe/Paris");
        expect(timed.dueAt?.toISOString()).toBe("2026-06-10T07:30:00.000Z"); // 09:30 CEST = 07:30Z

        const cleared = await setCommitmentDue(
          setCommitmentDueRequestSchema.parse({
            userId,
            taskId: created.taskId,
            dueOn: "2026-06-10",
          }),
        );
        expect(cleared.dueTime).toBeNull();
        expect(cleared.timeZone).toBeNull();
        expect(cleared.dueAt).toBeNull();

        const { rows } = await client.query(
          `SELECT metadata, object_instant FROM claims WHERE id = $1`,
          [cleared.claimId],
        );
        expect(rows[0].metadata).toBeNull();
        expect(rows[0].object_instant).toBeNull();
      } finally {
        resetTestOverrides();
      }
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("rejects dueTime without timeZone at the schema boundary", () => {
    expect(
      setCommitmentDueRequestSchema.safeParse({
        userId: "u",
        taskId: newTypeId("node"),
        dueOn: "2026-06-10",
        dueTime: "09:00",
      }).success,
    ).toBe(false);
  });
});
