import { runRollup } from "./rollup";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DrizzleDB } from "~/db";
import * as schema from "~/db/schema";
import {
  ROLLUP_TEST_TABLES_SQL,
  stubLlm,
} from "~/lib/rollup/summarize-period.test";
import { ensurePeriodNode } from "~/lib/temporal";
import { newTypeId } from "~/types/typeid";
import {
  resetTestOverrides,
  setExtractionClientOverride,
  setSkipEmbeddingPersistence,
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

const TODAY = "2026-06-15";

describeIfServer("runRollup", () => {
  const dbName = `memory_rollup_job_test_${Date.now()}_${Math.floor(
    Math.random() * 1e6,
  )}`;
  let client: Client;
  let db: DrizzleDB;

  beforeAll(async () => {
    setSkipEmbeddingPersistence(true);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();

    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await client.query(ROLLUP_TEST_TABLES_SQL);
    db = drizzle(client, { schema, casing: "snake_case" });
  });

  afterEach(() => {
    resetTestOverrides();
    setSkipEmbeddingPersistence(true);
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

  async function seedUser(userId: string): Promise<void> {
    await client.query(`INSERT INTO "users" ("id") VALUES ($1)`, [userId]);
  }

  /** A content node OCCURRED_ON the given day (creates the day node too). */
  async function seedContent(
    userId: string,
    dayKey: string,
    label: string,
  ): Promise<void> {
    const dayNodeId = await ensurePeriodNode(db, userId, dayKey);
    const contentNodeId = newTypeId("node");
    const sourceId = newTypeId("source");
    await client.query(
      `INSERT INTO "sources" ("id", "user_id", "type", "external_id")
       VALUES ($1, $2, 'conversation', $3)`,
      [sourceId, userId, `conv-${label}`],
    );
    await client.query(
      `INSERT INTO "nodes" ("id", "user_id", "node_type") VALUES ($1, $2, 'Conversation')`,
      [contentNodeId, userId],
    );
    await client.query(
      `INSERT INTO "node_metadata" ("id", "node_id", "label", "description")
       VALUES ($1, $2, $3, 'Some details.')`,
      [newTypeId("node_metadata"), contentNodeId, label],
    );
    await client.query(
      `INSERT INTO "claims" (
        "id", "user_id", "subject_node_id", "object_node_id", "predicate",
        "statement", "source_id", "asserted_by_kind", "stated_at"
      ) VALUES ($1, $2, $3, $4, 'OCCURRED_ON', 'occurred', $5, 'system', now())`,
      [newTypeId("claim"), userId, contentNodeId, dayNodeId, sourceId],
    );
  }

  async function pendingOf(userId: string): Promise<string[]> {
    const rows = await client.query(
      `SELECT "pending_periods" FROM "rollup_state" WHERE "user_id" = $1`,
      [userId],
    );
    return rows.rows[0]?.pending_periods ?? [];
  }

  async function summaryOf(
    userId: string,
    label: string,
  ): Promise<string | null> {
    const rows = await client.query(
      `SELECT m."description" FROM "node_metadata" m
       JOIN "nodes" n ON n."id" = m."node_id"
       WHERE n."user_id" = $1 AND m."label" = $2 AND m."additional_data" -> 'rollup' IS NOT NULL`,
      [userId, label],
    );
    return rows.rows[0]?.description ?? null;
  }

  it("builds the full hierarchy bottom-up and defers the open year", async () => {
    const userId = "u_full";
    await seedUser(userId);
    // W02 2026 = Jan 5–11; W03 = Jan 12–18.
    await seedContent(userId, "2026-01-05", "Kickoff");
    await seedContent(userId, "2026-01-07", "Design review");
    await seedContent(userId, "2026-01-13", "Retro");

    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });

    // 3 days + 2 weeks + 1 month = 6; year 2026 is still open.
    expect(result).toMatchObject({ summarized: 6, failed: 0 });
    expect(calls).toHaveLength(6);
    expect(await summaryOf(userId, "2026-01-05")).toMatch(/^LLM summary/);
    expect(await summaryOf(userId, "2026-W02")).toMatch(/^LLM summary/);
    expect(await summaryOf(userId, "2026-W03")).toMatch(/^LLM summary/);
    expect(await summaryOf(userId, "2026-01")).toMatch(/^LLM summary/);
    expect(await pendingOf(userId)).toEqual(["2026"]);

    // PART_OF: 3 day→week + 2 week→month (only existing week nodes link).
    const partOf = await client.query(
      `SELECT count(*)::int AS n FROM "claims" WHERE "user_id" = $1 AND "predicate" = 'PART_OF'`,
      [userId],
    );
    expect(partOf.rows[0].n).toBe(5);

    const state = await client.query(
      `SELECT "watermark" FROM "rollup_state" WHERE "user_id" = $1`,
      [userId],
    );
    expect(state.rows[0].watermark).not.toBeNull();
  });

  it("costs zero LLM calls when nothing changed", async () => {
    const userId = "u_full";
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    expect(result.summarized).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await pendingOf(userId)).toEqual(["2026"]);
  });

  it("summarizes a completed year", async () => {
    const userId = "u_year";
    await seedUser(userId);
    await seedContent(userId, "2025-03-10", "Spring planning");

    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    // day + week (2025-W11) + month (2025-03) + year (2025) = 4.
    expect(result.summarized).toBe(4);
    expect(calls).toHaveLength(4);
    expect(await summaryOf(userId, "2025")).toMatch(/^LLM summary/);
    expect(await pendingOf(userId)).toEqual([]);
  });

  it("re-summarizes the cascade when old content is backfilled", async () => {
    const userId = "u_full";
    // New claim (createdAt = now > watermark) pointing at the old day.
    await seedContent(userId, "2026-01-07", "Backfilled memo");

    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);

    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    // Day 2026-01-07 + week W02 + month 2026-01 re-run; W03 untouched.
    expect(result.summarized).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("defers over-budget work to pending and resumes on the next sweep", async () => {
    const userId = "u_budget";
    await seedUser(userId);
    await seedContent(userId, "2026-01-05", "A");
    await seedContent(userId, "2026-01-06", "B");
    await seedContent(userId, "2026-01-07", "C");
    await seedContent(userId, "2026-01-08", "D");
    await seedContent(userId, "2026-01-12", "E");

    const { client: llm1, calls: calls1 } = stubLlm();
    setExtractionClientOverride(llm1);
    const first = await runRollup({
      db,
      userId,
      maxLlmCalls: 3,
      todayKey: TODAY,
    });
    expect(first.summarized).toBe(3);
    expect(calls1).toHaveLength(3);
    const pendingAfterFirst = await pendingOf(userId);
    expect(pendingAfterFirst).toContain("2026-01-08");
    expect(pendingAfterFirst).toContain("2026-W02");

    const { client: llm2, calls: calls2 } = stubLlm();
    setExtractionClientOverride(llm2);
    const second = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      todayKey: TODAY,
    });
    // Remaining: days 01-08, 01-12 + weeks W02, W03 + month 2026-01 = 5.
    expect(second.summarized).toBe(5);
    expect(calls2).toHaveLength(5);
    expect(await pendingOf(userId)).toEqual(["2026"]);
  });

  it("startDate excludes pre-floor periods and purges them from pending", async () => {
    const userId = "u_floor";
    await seedUser(userId);
    await seedContent(userId, "2025-12-15", "Old era");
    await seedContent(userId, "2026-01-06", "New era");

    // First sweep with a zero budget: everything ready lands in pending.
    const { client: llm0 } = stubLlm();
    setExtractionClientOverride(llm0);
    const zero = await runRollup({
      db,
      userId,
      maxLlmCalls: 0,
      todayKey: TODAY,
    });
    expect(zero.summarized).toBe(0);
    expect(await pendingOf(userId)).toContain("2025-12-15");

    // Second sweep with the floor: 2025 periods are gone for good.
    const { client: llm, calls } = stubLlm();
    setExtractionClientOverride(llm);
    const result = await runRollup({
      db,
      userId,
      maxLlmCalls: 50,
      startDate: "2026-01-01",
      todayKey: TODAY,
    });
    // 2026-01-06 + W02 + 2026-01 = 3 (W02 ends 2026-01-11 ≥ floor).
    expect(result.summarized).toBe(3);
    expect(calls).toHaveLength(3);
    expect(await summaryOf(userId, "2025-12-15")).toBeNull();
    expect(await summaryOf(userId, "2025-12")).toBeNull();
    expect(await pendingOf(userId)).toEqual(["2026"]);
  });
});
