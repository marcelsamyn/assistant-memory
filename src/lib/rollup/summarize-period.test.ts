import { ensureRollupSource } from "./source";
import { summarizePeriod } from "./summarize-period";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { createCompletionClient } from "~/lib/ai";
import { ensurePeriodNode } from "~/lib/temporal";
import { newTypeId } from "~/types/typeid";
import {
  resetTestOverrides,
  setExtractionClientOverride,
  setSkipEmbeddingPersistence,
  type StubCompletionClient,
} from "~/utils/test-overrides";

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

/** All tables the rollup write path touches (embeddings are skipped). */
export const ROLLUP_TEST_TABLES_SQL = `
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
    "content_length" integer,
    CONSTRAINT "sources_user_type_external_unique"
      UNIQUE ("user_id", "type", "external_id")
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
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
  CREATE TABLE "rollup_state" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id"),
    "watermark" timestamp with time zone,
    "pending_periods" jsonb DEFAULT '[]' NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL
  );
`;

/** Stub LLM client that records prompts and returns canned summaries. */
export function stubLlm(): {
  client: StubCompletionClient;
  calls: string[];
} {
  const calls: string[] = [];
  const client = {
    chat: {
      completions: {
        parse: async (body: { messages: Array<{ content: string }> }) => {
          const prompt = body.messages.map((m) => m.content).join("\n");
          calls.push(prompt);
          return {
            choices: [
              {
                message: {
                  parsed: { summary: `LLM summary #${calls.length}` },
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  } as unknown as StubCompletionClient;
  return { client, calls };
}

describeIfServer("summarizePeriod", () => {
  const dbName = `memory_summarize_period_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  const userId = "user_sp";
  let client: Client;

  beforeAll(async () => {
    setSkipEmbeddingPersistence(true);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(ROLLUP_TEST_TABLES_SQL);
    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  });

  afterAll(async () => {
    resetTestOverrides();
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

  it("skips a day with no linked content", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    const outcome = await summarizePeriod({
      db,
      userId,
      periodKey: "2026-01-05",
      client: openai,
      rollupSourceId,
    });
    expect(outcome).toBe("skipped-empty");
  });

  it("summarizes a day with content, then fingerprint-skips a re-run", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    // Seed: a day node + one content node linked via OCCURRED_ON.
    const dayNodeId = await ensurePeriodNode(db, userId, "2026-01-06");
    const contentNodeId = newTypeId("node");
    const contentSourceId = newTypeId("source");
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
       VALUES ($1, $2, 'conversation', 'conv-1')`,
      [contentSourceId, userId],
    );
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Conversation')`,
      [contentNodeId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "description")
       VALUES ($1, $2, 'Standup', 'Talked about rollups with Sam.')`,
      [newTypeId("node_metadata"), contentNodeId],
    );
    await client.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_node_id", "predicate",
        "statement", "source_id", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, $4, 'OCCURRED_ON', 'occurred', $5, 'system', now())`,
      [newTypeId("claim"), userId, contentNodeId, dayNodeId, contentSourceId],
    );

    const params = {
      db,
      userId,
      periodKey: "2026-01-06",
      client: openai,
      rollupSourceId,
    };
    expect(await summarizePeriod(params)).toBe("summarized");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("Standup");

    const meta = await client.query(
      `SELECT m."description", m."additional_data" FROM "node_metadata" m
       WHERE m."node_id" = $1`,
      [dayNodeId],
    );
    expect(meta.rows[0].description).toBe("LLM summary #1");
    expect(meta.rows[0].additional_data.rollup.fingerprint).toMatch(
      /^[0-9a-f]{64}$/,
    );

    // Unchanged input → no second LLM call.
    expect(await summarizePeriod(params)).toBe("skipped-unchanged");
    expect(calls).toHaveLength(1);
  });

  it("summarizes a week from day summaries and ensures PART_OF claims idempotently", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    // 2026-01-06 already has a summarized day node from the previous test.
    const params = {
      db,
      userId,
      periodKey: "2026-W02", // Jan 5–11 2026
      client: openai,
      rollupSourceId,
    };
    expect(await summarizePeriod(params)).toBe("summarized");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("2026-01-06: LLM summary");
    expect(calls[0]).toContain("(no summarized activity)");

    const partOf = await client.query(
      `SELECT c."statement" FROM "claims" c WHERE c."predicate" = 'PART_OF' AND c."user_id" = $1`,
      [userId],
    );
    // Only the existing day node gets an edge (the other 6 days have no node).
    expect(partOf.rowCount).toBe(1);
    expect(partOf.rows[0].statement).toBe("2026-01-06 is part of 2026-W02");

    // Re-run: fingerprint-skips, and does not duplicate the claim.
    expect(await summarizePeriod(params)).toBe("skipped-unchanged");
    const partOfAgain = await client.query(
      `SELECT count(*)::int AS n FROM "claims" WHERE "predicate" = 'PART_OF' AND "user_id" = $1`,
      [userId],
    );
    expect(partOfAgain.rows[0].n).toBe(1);
  });

  it("skips a week whose days have no summaries", async () => {
    const db = drizzle(client, { schema, casing: "snake_case" });
    const { client: llm } = stubLlm();
    setExtractionClientOverride(llm);
    const rollupSourceId = await ensureRollupSource(db, userId);
    const openai = await createCompletionClient(userId);

    expect(
      await summarizePeriod({
        db,
        userId,
        periodKey: "2026-W30",
        client: openai,
        rollupSourceId,
      }),
    ).toBe("skipped-empty");
  });
});
