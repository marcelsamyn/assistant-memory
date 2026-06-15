import { loadTimelinePeriods, periodKeysForWindow } from "./timeline-periods";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId } from "~/types/typeid";

describe("periodKeysForWindow", () => {
  // June 1 2026 is a Monday (ISO 2026-W23); June 29 2026 is a Monday (2026-W27).
  it("includes the year, month, and ISO weeks containing days in the window", () => {
    const keys = periodKeysForWindow("2026-06-01", "2026-06-30");
    expect(keys).toContain("2026");
    expect(keys).toContain("2026-06");
    expect(keys).toContain("2026-W23");
    expect(keys).toContain("2026-W27");
  });

  it("excludes adjacent months and any day-format keys", () => {
    const keys = periodKeysForWindow("2026-06-01", "2026-06-30");
    expect(keys).not.toContain("2026-05");
    expect(keys).not.toContain("2026-07");
    expect(keys.every((k) => !/^\d{4}-\d{2}-\d{2}$/.test(k))).toBe(true);
  });

  it("handles a single-day window", () => {
    const keys = periodKeysForWindow("2026-06-10", "2026-06-10");
    expect(keys.sort()).toEqual(["2026", "2026-06", "2026-W24"].sort());
  });
});

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

describeIfServer("loadTimelinePeriods", () => {
  const dbName = `memory_timeline_periods_test_${Date.now()}_${Math.floor(
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

  it("returns week/month/year summaries for the window, null until summarized", async () => {
    const userId = "user_timeline_periods";

    const dayN = newTypeId("node"); // 2026-06-10 — must be excluded
    const weekN = newTypeId("node"); // 2026-W24 — summarized
    const monthN = newTypeId("node"); // 2026-06 — summarized
    const yearN = newTypeId("node"); // 2026 — NOT summarized
    const otherMonthN = newTypeId("node"); // 2026-05 — out of window

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    try {
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
      `);

      await database.insert(schema.users).values({ id: userId });

      await database.insert(schema.nodes).values([
        { id: dayN, userId, nodeType: "Temporal" },
        { id: weekN, userId, nodeType: "Temporal" },
        { id: monthN, userId, nodeType: "Temporal" },
        { id: yearN, userId, nodeType: "Temporal" },
        { id: otherMonthN, userId, nodeType: "Temporal" },
      ]);

      await database.insert(schema.nodeMetadata).values([
        { id: newTypeId("node_metadata"), nodeId: dayN, label: "2026-06-10" },
        {
          id: newTypeId("node_metadata"),
          nodeId: weekN,
          label: "2026-W24",
          description: "Week 24 summary",
          additionalData: {
            rollup: {
              fingerprint: "f1",
              summarizedAt: "2026-06-15T00:00:00.000Z",
            },
          },
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: monthN,
          label: "2026-06",
          description: "June summary",
          additionalData: {
            rollup: {
              fingerprint: "f2",
              summarizedAt: "2026-06-15T00:00:00.000Z",
            },
          },
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: yearN,
          label: "2026",
          description: "Represents the year 2026",
          additionalData: null,
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: otherMonthN,
          label: "2026-05",
          description: "May summary",
          additionalData: {
            rollup: {
              fingerprint: "f3",
              summarizedAt: "2026-06-15T00:00:00.000Z",
            },
          },
        },
      ]);

      const periods = await loadTimelinePeriods(
        database,
        userId,
        "2026-06-01",
        "2026-06-30",
      );

      // Ordered by label ascending: "2026" < "2026-06" < "2026-W24".
      expect(periods.map((p) => p.key)).toEqual([
        "2026",
        "2026-06",
        "2026-W24",
      ]);
      expect(periods.map((p) => p.granularity)).toEqual([
        "year",
        "month",
        "week",
      ]);
      expect(periods.find((p) => p.key === "2026")!.summary).toBeNull();
      expect(periods.find((p) => p.key === "2026-06")!.summary).toBe(
        "June summary",
      );
      expect(periods.find((p) => p.key === "2026-W24")).toMatchObject({
        summary: "Week 24 summary",
        temporalNodeId: weekN,
      });
      expect(periods.map((p) => p.key)).not.toContain("2026-06-10");
      expect(periods.map((p) => p.key)).not.toContain("2026-05");

      expect(
        await loadTimelinePeriods(
          database,
          "nobody",
          "2026-06-01",
          "2026-06-30",
        ),
      ).toEqual([]);
    } finally {
      await client.end();
    }
  });
});
