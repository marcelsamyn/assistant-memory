import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "~/db/schema";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import {
  queryTimelineRequestSchema,
  queryTimelineResponseSchema,
} from "~/lib/schemas/query-timeline";
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

process.env["DATABASE_URL"] ??= adminDsn();

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

describeIfServer("queryTimeline", () => {
  const dbName = `memory_timeline_test_${Date.now()}_${Math.floor(
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

  it("excludes rollup nodes from days and returns periods only when asked", async () => {
    const userId = "user_timeline";

    const alice = newTypeId("node");
    const day10 = newTypeId("node"); // 2026-06-10
    const day11 = newTypeId("node"); // 2026-06-11
    const monthN = newTypeId("node"); // 2026-06 rollup — must NOT appear as a day
    const weekN = newTypeId("node"); // 2026-W24 rollup
    const yearN = newTypeId("node"); // 2026 rollup (unsummarized)
    const monthJul = newTypeId("node"); // 2026-07 rollup — leaks into days w/o the guard
    const src = newTypeId("source");
    const claim1 = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });

    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

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
      await installPartitionCompatibilityFixture(client);

      await database.insert(schema.users).values({ id: userId });
      await database.insert(schema.sources).values({
        id: src,
        userId,
        type: "conversation",
        externalId: "conv:1",
        scope: "personal",
        status: "completed",
        createdAt: new Date("2026-06-10T08:00:00.000Z"),
      });

      await database.insert(schema.nodes).values([
        { id: alice, userId, nodeType: "Person" },
        { id: day10, userId, nodeType: "Temporal" },
        { id: day11, userId, nodeType: "Temporal" },
        { id: monthN, userId, nodeType: "Temporal" },
        { id: weekN, userId, nodeType: "Temporal" },
        { id: yearN, userId, nodeType: "Temporal" },
        { id: monthJul, userId, nodeType: "Temporal" },
      ]);

      await database.insert(schema.nodeMetadata).values([
        { id: newTypeId("node_metadata"), nodeId: alice, label: "Alice" },
        { id: newTypeId("node_metadata"), nodeId: day10, label: "2026-06-10" },
        { id: newTypeId("node_metadata"), nodeId: day11, label: "2026-06-11" },
        {
          id: newTypeId("node_metadata"),
          nodeId: monthN,
          label: "2026-06",
          description: "June summary",
          additionalData: {
            rollup: {
              fingerprint: "f1",
              summarizedAt: "2026-06-15T00:00:00.000Z",
            },
          },
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: weekN,
          label: "2026-W24",
          description: "Week 24 summary",
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
          nodeId: monthJul,
          label: "2026-07",
          description: "July summary",
          additionalData: {
            rollup: {
              fingerprint: "f4",
              summarizedAt: "2026-06-15T00:00:00.000Z",
            },
          },
        },
      ]);

      await database.insert(schema.claims).values({
        id: claim1,
        userId,
        subjectNodeId: alice,
        objectNodeId: day10,
        predicate: "OCCURRED_ON",
        statement: "Alice occurred on 2026-06-10.",
        sourceId: src,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-06-10T10:00:00.000Z"),
        status: "active",
        createdAt: new Date("2026-06-10T10:00:00.000Z"),
        updatedAt: new Date("2026-06-10T10:00:00.000Z"),
      });

      const { queryTimeline } = await import("./timeline");

      const base = queryTimelineResponseSchema.parse(
        await queryTimeline(
          queryTimelineRequestSchema.parse({
            userId,
            since: "2026-06-01",
            until: "2026-06-30",
          }),
        ),
      );
      expect(base.days.map((d) => d.date)).toEqual([
        "2026-06-11",
        "2026-06-10",
      ]);
      expect(base.days.map((d) => d.date)).not.toContain("2026-06");
      expect(base.totalDays).toBe(2);
      expect(base.hasMore).toBe(false);
      expect(base.periods).toEqual([]);
      expect(base.days.find((d) => d.date === "2026-06-10")?.nodeCount).toBe(1);

      const withPeriods = queryTimelineResponseSchema.parse(
        await queryTimeline(
          queryTimelineRequestSchema.parse({
            userId,
            since: "2026-06-01",
            until: "2026-06-30",
            includePeriods: true,
          }),
        ),
      );
      expect(withPeriods.days.map((d) => d.date)).toEqual([
        "2026-06-11",
        "2026-06-10",
      ]);
      expect(withPeriods.periods.map((p) => p.key)).toEqual([
        "2026",
        "2026-06",
        "2026-W24",
      ]);
      expect(
        withPeriods.periods.find((p) => p.key === "2026")!.summary,
      ).toBeNull();
      expect(
        withPeriods.periods.find((p) => p.key === "2026-06")!.summary,
      ).toBe("June summary");

      // Regression: the Petals past feed sends only `until` (open `since`).
      // The week/month/year periods for in-range days must come back — not just
      // the current period — which the old `endDate`-collapses-the-window bug
      // dropped.
      const pastFeed = queryTimelineResponseSchema.parse(
        await queryTimeline(
          queryTimelineRequestSchema.parse({
            userId,
            until: "2026-12-31",
            includePeriods: true,
          }),
        ),
      );
      expect(pastFeed.periods.map((p) => p.key)).toEqual([
        "2026",
        "2026-06",
        "2026-W24",
      ]);

      // Day-feed guard: a 2026-07 month rollup node sorts INSIDE a window that
      // extends into July, so without the `~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
      // guard it would leak into `days`. Only the seeded June day nodes should
      // appear (no July day nodes exist).
      const spanning = queryTimelineResponseSchema.parse(
        await queryTimeline(
          queryTimelineRequestSchema.parse({
            userId,
            since: "2026-06-01",
            until: "2026-07-31",
          }),
        ),
      );
      expect(spanning.days.map((d) => d.date)).toEqual([
        "2026-06-11",
        "2026-06-10",
      ]);
      expect(spanning.days.map((d) => d.date)).not.toContain("2026-07");
      expect(spanning.days.map((d) => d.date)).not.toContain("2026-06");
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });

  it("paginates workspace days by distinct date and unions active partitions", async () => {
    const userId = "user_timeline_workspace";
    const otherUserId = "other_timeline_workspace";
    const partitionA = contextPartitionKeySchema.parse("timeline:active-a");
    const partitionB = contextPartitionKeySchema.parse("timeline:active-b");
    const inactivePartition =
      contextPartitionKeySchema.parse("timeline:inactive");
    const foreignPartition =
      contextPartitionKeySchema.parse("timeline:foreign");
    const dayA = newTypeId("node");
    const dayB = newTypeId("node");
    const olderDay = newTypeId("node");
    const inactiveDay = newTypeId("node");
    const foreignDay = newTypeId("node");
    const entryA = newTypeId("node");
    const entryB = newTypeId("node");
    const olderEntry = newTypeId("node");
    const inactiveEntry = newTypeId("node");
    const foreignEntry = newTypeId("node");
    const sourceA = newTypeId("source");
    const sourceB = newTypeId("source");
    const olderSource = newTypeId("source");
    const inactiveSource = newTypeId("source");
    const foreignSource = newTypeId("source");
    const claimA = newTypeId("claim");
    const claimB = newTypeId("claim");
    const olderClaim = newTypeId("claim");
    const inactiveClaim = newTypeId("claim");
    const foreignClaim = newTypeId("claim");

    const client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    const database = drizzle(client, { schema, casing: "snake_case" });
    vi.resetModules();
    vi.doMock("~/utils/db", () => ({ useDatabase: async () => database }));

    try {
      await database
        .insert(schema.users)
        .values([{ id: userId }, { id: otherUserId }]);
      await database.insert(schema.memoryPartitions).values([
        { userId, partitionKey: partitionA, status: "active" },
        { userId, partitionKey: partitionB, status: "active" },
        { userId, partitionKey: inactivePartition, status: "quarantined" },
        {
          userId: otherUserId,
          partitionKey: foreignPartition,
          status: "active",
        },
      ]);
      await database.insert(schema.partitionMigrationState).values({
        userId,
        state: "migrated",
      });
      await database.insert(schema.sources).values([
        {
          id: sourceA,
          userId,
          partitionKey: partitionA,
          type: "conversation",
          externalId: "timeline-source-a",
          status: "completed",
        },
        {
          id: sourceB,
          userId,
          partitionKey: partitionB,
          type: "conversation",
          externalId: "timeline-source-b",
          status: "completed",
        },
        {
          id: olderSource,
          userId,
          partitionKey: partitionA,
          type: "conversation",
          externalId: "timeline-source-older",
          status: "completed",
        },
        {
          id: inactiveSource,
          userId,
          partitionKey: inactivePartition,
          type: "conversation",
          externalId: "timeline-source-inactive",
          status: "completed",
        },
        {
          id: foreignSource,
          userId: otherUserId,
          partitionKey: foreignPartition,
          type: "conversation",
          externalId: "timeline-source-foreign",
          status: "completed",
        },
      ]);
      await database.insert(schema.nodes).values([
        { id: dayA, userId, partitionKey: partitionA, nodeType: "Temporal" },
        { id: dayB, userId, partitionKey: partitionB, nodeType: "Temporal" },
        {
          id: olderDay,
          userId,
          partitionKey: partitionA,
          nodeType: "Temporal",
        },
        {
          id: inactiveDay,
          userId,
          partitionKey: inactivePartition,
          nodeType: "Temporal",
        },
        {
          id: foreignDay,
          userId: otherUserId,
          partitionKey: foreignPartition,
          nodeType: "Temporal",
        },
        { id: entryA, userId, partitionKey: partitionA, nodeType: "Person" },
        { id: entryB, userId, partitionKey: partitionB, nodeType: "Person" },
        {
          id: olderEntry,
          userId,
          partitionKey: partitionA,
          nodeType: "Person",
        },
        {
          id: inactiveEntry,
          userId,
          partitionKey: inactivePartition,
          nodeType: "Person",
        },
        {
          id: foreignEntry,
          userId: otherUserId,
          partitionKey: foreignPartition,
          nodeType: "Person",
        },
      ]);
      await database.insert(schema.nodeMetadata).values([
        { id: newTypeId("node_metadata"), nodeId: dayA, label: "2026-06-11" },
        { id: newTypeId("node_metadata"), nodeId: dayB, label: "2026-06-11" },
        {
          id: newTypeId("node_metadata"),
          nodeId: olderDay,
          label: "2026-06-10",
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: inactiveDay,
          label: "2026-06-12",
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: foreignDay,
          label: "2026-06-13",
        },
        { id: newTypeId("node_metadata"), nodeId: entryA, label: "A" },
        { id: newTypeId("node_metadata"), nodeId: entryB, label: "B" },
        { id: newTypeId("node_metadata"), nodeId: olderEntry, label: "Older" },
        {
          id: newTypeId("node_metadata"),
          nodeId: inactiveEntry,
          label: "Inactive",
        },
        {
          id: newTypeId("node_metadata"),
          nodeId: foreignEntry,
          label: "Foreign",
        },
      ]);
      await database.insert(schema.claims).values([
        {
          id: claimA,
          userId,
          partitionKey: partitionA,
          subjectNodeId: entryA,
          objectNodeId: dayA,
          predicate: "OCCURRED_ON",
          statement: "A occurred on 2026-06-11.",
          sourceId: sourceA,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-06-11T10:00:00.000Z"),
          status: "active",
        },
        {
          id: claimB,
          userId,
          partitionKey: partitionB,
          subjectNodeId: entryB,
          objectNodeId: dayB,
          predicate: "OCCURRED_ON",
          statement: "B occurred on 2026-06-11.",
          sourceId: sourceB,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-06-11T09:00:00.000Z"),
          status: "active",
        },
        {
          id: olderClaim,
          userId,
          partitionKey: partitionA,
          subjectNodeId: olderEntry,
          objectNodeId: olderDay,
          predicate: "OCCURRED_ON",
          statement: "Older occurred on 2026-06-10.",
          sourceId: olderSource,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-06-10T10:00:00.000Z"),
          status: "active",
        },
        {
          id: inactiveClaim,
          userId,
          partitionKey: inactivePartition,
          subjectNodeId: inactiveEntry,
          objectNodeId: inactiveDay,
          predicate: "OCCURRED_ON",
          statement: "Inactive occurred on 2026-06-12.",
          sourceId: inactiveSource,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-06-12T10:00:00.000Z"),
          status: "active",
        },
        {
          id: foreignClaim,
          userId: otherUserId,
          partitionKey: foreignPartition,
          subjectNodeId: foreignEntry,
          objectNodeId: foreignDay,
          predicate: "OCCURRED_ON",
          statement: "Foreign occurred on 2026-06-13.",
          sourceId: foreignSource,
          scope: "personal",
          assertedByKind: "user",
          statedAt: new Date("2026-06-13T10:00:00.000Z"),
          status: "active",
        },
      ]);

      const { queryTimeline } = await import("./timeline");
      const firstPage = queryTimelineResponseSchema.parse(
        await queryTimeline({
          ...queryTimelineRequestSchema.parse({
            userId,
            limit: 1,
            offset: 0,
          }),
          accessScope: "workspace",
        }),
      );
      expect(firstPage.totalDays).toBe(2);
      expect(firstPage.days).toHaveLength(1);
      expect(firstPage.days[0]).toMatchObject({
        date: "2026-06-11",
        temporalNodeId: [dayA, dayB].sort()[0],
        nodeCount: 2,
      });
      expect(firstPage.days[0]!.nodes.map((node) => node.id).sort()).toEqual(
        [entryA, entryB].sort(),
      );
      expect(firstPage.hasMore).toBe(true);

      const secondPage = queryTimelineResponseSchema.parse(
        await queryTimeline({
          ...queryTimelineRequestSchema.parse({
            userId,
            limit: 1,
            offset: 1,
          }),
          accessScope: "workspace",
        }),
      );
      expect(secondPage.days).toMatchObject([
        {
          date: "2026-06-10",
          temporalNodeId: olderDay,
          nodeCount: 1,
        },
      ]);
      expect(secondPage.hasMore).toBe(false);
    } finally {
      vi.doUnmock("~/utils/db");
      vi.resetModules();
      await client.end();
    }
  });
});
