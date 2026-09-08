import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as schema from "~/db/schema";
import { claims, nodes, sourceLinks, sources, users } from "~/db/schema";
import { type LogEvent, setLogSink } from "~/lib/observability/log";
import { contextPartitionKeySchema } from "~/lib/schemas/partition";
import { ensureUserSelfIdentity } from "~/lib/user-self-identity";
import { newTypeId } from "~/types/typeid";
import { runDatabaseMigrations } from "~/utils/migrations";
import {
  resetTestOverrides,
  setSkipEmbeddingPersistence,
} from "~/utils/test-overrides";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";

process.env["DATABASE_URL"] ??=
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_ADMIN_DB}`;
process.env["MEMORY_OPENAI_API_KEY"] ??= "test";
process.env["MEMORY_OPENAI_API_BASE_URL"] ??= "http://localhost";
process.env["MODEL_ID_GRAPH_EXTRACTION"] ??= "test";
process.env["JINA_API_KEY"] ??= "test";
process.env["REDIS_URL"] ??= "redis://localhost:6379";
process.env["MINIO_ENDPOINT"] ??= "localhost";
process.env["MINIO_ACCESS_KEY"] ??= "test";
process.env["MINIO_SECRET_KEY"] ??= "test";
process.env["SOURCES_BUCKET"] ??= "test";

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

const journalSchema = z
  .object({
    entries: z.array(
      z.object({ idx: z.number().int(), tag: z.string() }).passthrough(),
    ),
  })
  .passthrough();

async function makeMigrationPrefix(lastIndex: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "memory-migrations-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = journalSchema.parse(
    JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")),
  );
  const entries = journal.entries.filter((entry) => entry.idx <= lastIndex);
  await writeFile(
    join(metaDirectory, "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  await Promise.all(
    entries.map((entry) =>
      cp(
        join("drizzle", `${entry.tag}.sql`),
        join(directory, `${entry.tag}.sql`),
      ),
    ),
  );
  return directory;
}

const describeIfServer = (await isServerReachable()) ? describe : describe.skip;

describeIfServer("partition migration upgrade", () => {
  const dbName = `memory_partition_upgrade_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;
  let database: NodePgDatabase<typeof schema>;
  let legacyMigrations: string;
  let preFeedMigrations: string;
  let preRedactionMigrations: string;

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    database = drizzle(client, { schema, casing: "snake_case" });
    legacyMigrations = await makeMigrationPrefix(27);
    preFeedMigrations = await makeMigrationPrefix(28);
    preRedactionMigrations = await makeMigrationPrefix(35);
  });

  afterAll(async () => {
    await client.end();
    await Promise.all([
      rm(legacyMigrations, { recursive: true, force: true }),
      rm(preFeedMigrations, { recursive: true, force: true }),
      rm(preRedactionMigrations, { recursive: true, force: true }),
    ]);
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("preserves populated 0027 data through the partition and lifecycle chain", async () => {
    await migrate(database, { migrationsFolder: legacyMigrations });
    const userId = "legacy-upgrade-user";
    const sourceId = newTypeId("source");
    const nodeId = newTypeId("node");
    const linkId = newTypeId("source_link");
    const claimId = newTypeId("claim");
    await client.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await client.query(
      `INSERT INTO sources
        (id, user_id, type, external_id, scope, last_ingested_at, status, metadata)
       VALUES ($1, $2, 'document', 'legacy-document', 'personal', now(), 'completed', $3::jsonb)`,
      [sourceId, userId, JSON.stringify({ rawContent: "legacy content" })],
    );
    await client.query(
      "INSERT INTO nodes (id, user_id, node_type) VALUES ($1, $2, 'Person')",
      [nodeId, userId],
    );
    await client.query(
      "INSERT INTO source_links (id, source_id, node_id) VALUES ($1, $2, $3)",
      [linkId, sourceId, nodeId],
    );
    await client.query(
      `INSERT INTO claims
        (id, user_id, subject_node_id, predicate, statement, object_value,
         source_id, stated_at, status, scope, asserted_by_kind)
       VALUES ($1, $2, $3, 'HAS_TASK_STATUS', 'Legacy task', 'pending',
         $4, now(), 'active', 'personal', 'user')`,
      [claimId, userId, nodeId, sourceId],
    );

    await client.query(
      "INSERT INTO users (id) VALUES ('backfill-volume-user')",
    );
    await client.query(`INSERT INTO nodes (id, user_id, node_type)
      SELECT 'node_' || lpad(i::text, 26, '0'), 'backfill-volume-user', 'Person'
      FROM generate_series(1, 12000) i`);
    await migrate(database, { migrationsFolder: preFeedMigrations });
    await client.query(`INSERT INTO memory_partitions (user_id, partition_key)
      VALUES ('backfill-volume-user', 'room:backfill')`);
    await client.query(`UPDATE nodes SET partition_key = 'room:backfill'
      WHERE user_id = 'backfill-volume-user' AND id <= 'node_' || lpad('6000', 26, '0')`);
    await client.query(`INSERT INTO node_redirects (user_id, partition_key, from_node_id, to_node_id)
      VALUES ('backfill-volume-user', 'room:backfill', 'node_' || lpad('1', 26, '0'), 'node_' || lpad('2', 26, '0'))`);
    const upgradeStarted = performance.now();
    const migrationEvents: LogEvent[] = [];
    setLogSink((event) => migrationEvents.push(event));
    try {
      await runDatabaseMigrations(dsnFor(dbName), preRedactionMigrations);
    } finally {
      setLogSink();
    }
    expect(migrationEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "database.migrations.started",
          phase: "connecting",
        }),
        expect.objectContaining({
          event: "database.migrations.progress",
          phase: "waiting_for_lock",
        }),
        expect.objectContaining({
          event: "database.migrations.backfill",
          step: "backfill_verified",
          rows: 12007,
        }),
        expect.objectContaining({
          event: "database.migrations.completed",
          phase: "committed",
        }),
      ]),
    );
    console.info(
      `Populated migration upgrade: ${Math.round(performance.now() - upgradeStarted)}ms`,
    );
    const volumeFeed =
      await client.query(`SELECT partition_key, count(*)::int AS count,
      min(sequence)::int AS first, max(sequence)::int AS last,
      count(DISTINCT event_id)::int AS unique_ids
      FROM memory_change_feed_events WHERE user_id = 'backfill-volume-user'
      GROUP BY partition_key ORDER BY partition_key NULLS FIRST`);
    expect(volumeFeed.rows).toEqual([
      {
        partition_key: null,
        count: 6000,
        first: 1,
        last: 6000,
        unique_ids: 6000,
      },
      {
        partition_key: "room:backfill",
        count: 6001,
        first: 1,
        last: 6001,
        unique_ids: 6001,
      },
    ]);
    const volumeHead =
      await client.query(`SELECT partition_key, next_sequence::int AS next
      FROM memory_change_feed_heads WHERE user_id = 'backfill-volume-user'
      ORDER BY partition_key NULLS FIRST`);
    expect(volumeHead.rows).toEqual([
      { partition_key: null, next: 6001 },
      { partition_key: "room:backfill", next: 6002 },
    ]);
    const legacyFeed = await client.query(
      `SELECT kind FROM memory_change_feed_events
      WHERE user_id = $1 ORDER BY sequence`,
      [userId],
    );
    expect(legacyFeed.rows.map((row) => row.kind)).toEqual([
      "node",
      "source",
      "ingestion",
      "claim",
      "commitment",
      "provenance",
    ]);
    const invalidEventIds = await client.query(`SELECT count(*)::int AS count
      FROM memory_change_feed_events
      WHERE event_id <> 'mcfe_' || md5(jsonb_build_array(user_id, partition_key, feed_epoch, sequence)::text)`);
    expect(invalidEventIds.rows).toEqual([{ count: 0 }]);
    await client.query(
      `UPDATE memory_change_feed_heads
       SET next_sequence = 1000002
       WHERE user_id = $1 AND partition_key IS NULL`,
      [userId],
    );
    await client.query(
      `INSERT INTO memory_change_feed_events
        (event_id, user_id, feed_epoch, sequence, kind, action, entity_type,
         entity_id, source_id, effective_change_time, provenance, freshness,
         status, payload)
       VALUES
        ('pre-0036-tombstone', $1, 1, 1000000, 'deletion', 'tombstone',
         'source', $2, $2, now(), $3::jsonb, $3::jsonb, 'completed', $3::jsonb)`,
      [userId, sourceId, JSON.stringify({ secret: "must be redacted" })],
    );

    await migrate(database, { migrationsFolder: "./drizzle" });

    await expect(database.select().from(users)).resolves.toContainEqual({
      id: userId,
    });
    await expect(database.select().from(sources)).resolves.toContainEqual(
      expect.objectContaining({
        id: sourceId,
        userId,
        partitionKey: null,
        version: 0,
        deletedAt: null,
        metadata: { rawContent: "legacy content" },
      }),
    );
    await expect(database.select().from(nodes)).resolves.toContainEqual(
      expect.objectContaining({ id: nodeId, userId, partitionKey: null }),
    );
    await expect(database.select().from(claims)).resolves.toContainEqual(
      expect.objectContaining({
        id: claimId,
        sourceId,
        partitionKey: null,
      }),
    );
    await expect(database.select().from(sourceLinks)).resolves.toContainEqual(
      expect.objectContaining({ id: linkId, sourceId, nodeId }),
    );
    const applied = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );
    const journal = journalSchema.parse(
      JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")),
    );
    expect(Number(applied.rows[0]?.count)).toBe(journal.entries.length);

    const backfilled = await client.query<{
      feed_epoch: number;
      provenance: unknown;
      freshness: unknown;
      status: string | null;
      payload: unknown;
    }>(
      `SELECT feed_epoch, provenance, freshness, status, payload
       FROM memory_change_feed_events
       WHERE event_id = 'pre-0036-tombstone'`,
    );
    expect(backfilled.rows[0]).toEqual({
      feed_epoch: 2,
      provenance: {},
      freshness: null,
      status: null,
      payload: {},
    });
    const epoch = await client.query<{ feed_epoch: number }>(
      `SELECT feed_epoch
       FROM memory_change_feed_heads
       WHERE user_id = $1 AND partition_key IS NULL`,
      [userId],
    );
    expect(epoch.rows[0]?.feed_epoch).toBe(2);

    await client.query(
      `INSERT INTO memory_change_feed_events
        (event_id, user_id, feed_epoch, sequence, kind, action, entity_type,
         entity_id, source_id, effective_change_time, provenance, freshness,
         status, payload)
       VALUES
        ('post-0036-tombstone', $1, 2, 1000001, 'deletion', 'tombstone',
         'source', $2, $2, now(), $3::jsonb, $3::jsonb, 'completed', $3::jsonb)`,
      [userId, sourceId, JSON.stringify({ secret: "must also be redacted" })],
    );
    const inserted = await client.query<{
      provenance: unknown;
      freshness: unknown;
      status: string | null;
      payload: unknown;
    }>(
      `SELECT provenance, freshness, status, payload
       FROM memory_change_feed_events
       WHERE event_id = 'post-0036-tombstone'`,
    );
    expect(inserted.rows[0]).toEqual({
      provenance: {},
      freshness: null,
      status: null,
      payload: {},
    });
  }, 120_000);

  it("does not replay an applied migration when its SQL hash changes", async () => {
    const snapshotQuery = `SELECT count(*)::int AS count,
      md5(string_agg(event_id, ',' ORDER BY event_id)) AS fingerprint
      FROM memory_change_feed_events`;
    const before = await client.query(snapshotQuery);
    await client.query(`UPDATE drizzle.__drizzle_migrations
      SET hash = 'previously-applied-migration-content'
      WHERE created_at = (SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at OFFSET 29 LIMIT 1)`);
    const events: LogEvent[] = [];
    setLogSink((event) => events.push(event));
    try {
      await runDatabaseMigrations(dsnFor(dbName));
    } finally {
      setLogSink();
    }
    expect((await client.query(snapshotQuery)).rows).toEqual(before.rows);
    expect(
      events.some((event) => event.event === "database.migrations.backfill"),
    ).toBe(false);
    expect(events.at(-1)).toMatchObject({
      event: "database.migrations.completed",
      phase: "committed",
    });
  });

  it("reports a heartbeat while another session holds the migration lock", async () => {
    await client.query("SELECT pg_advisory_lock(1777558586, 0)");
    const events: LogEvent[] = [];
    setLogSink((event) => events.push(event));
    const pending = runDatabaseMigrations(dsnFor(dbName));
    try {
      await vi.waitFor(
        () => {
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                event: "database.migrations.progress",
                phase: "waiting_for_lock",
                elapsedMs: expect.any(Number),
              }),
            ]),
          );
          expect(
            events.some(
              (event) =>
                event["phase"] === "waiting_for_lock" &&
                Number(event["elapsedMs"]) >= 10_000,
            ),
          ).toBe(true);
        },
        { timeout: 12_000, interval: 100 },
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock(1777558586, 0)");
      try {
        await pending;
      } finally {
        setLogSink();
      }
    }
    expect(events.at(-1)).toMatchObject({
      event: "database.migrations.completed",
    });
  }, 15_000);

  it("fails with repair guidance for a legacy cross-user parent link", async () => {
    const invalidDbName = `memory_partition_invalid_parent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new Client({ connectionString: adminDsn() });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${invalidDbName}"`);
    await admin.end();
    const invalidClient = new Client({
      connectionString: dsnFor(invalidDbName),
    });
    await invalidClient.connect();
    const invalidDatabase = drizzle(invalidClient, {
      schema,
      casing: "snake_case",
    });
    const invalidLegacyMigrations = await makeMigrationPrefix(27);
    const invalidPreRedactionMigrations = await makeMigrationPrefix(35);
    try {
      await migrate(invalidDatabase, {
        migrationsFolder: invalidLegacyMigrations,
      });
      const parentId = newTypeId("source");
      const childId = newTypeId("source");
      await invalidClient.query(
        "INSERT INTO users (id) VALUES ('parent-user'), ('child-user')",
      );
      await invalidClient.query(
        `INSERT INTO sources
          (id, user_id, type, external_id, scope, last_ingested_at, status, metadata)
         VALUES
          ($1, 'parent-user', 'document', 'parent', 'personal', now(), 'completed', '{}'::jsonb),
          ($2, 'child-user', 'document', 'child', 'personal', now(), 'completed', '{}'::jsonb)`,
        [parentId, childId],
      );
      await invalidClient.query(
        "UPDATE sources SET parent_source = $1 WHERE id = $2",
        [parentId, childId],
      );
      await migrate(invalidDatabase, {
        migrationsFolder: invalidPreRedactionMigrations,
      });

      const events: LogEvent[] = [];
      setLogSink((event) => events.push(event));
      try {
        await expect(
          runDatabaseMigrations(dsnFor(invalidDbName)),
        ).rejects.toThrow(/legacy sources contain cross-user parent links/);
      } finally {
        setLogSink();
      }
      expect(events.at(-1)).toMatchObject({
        event: "database.migrations.failed",
        phase: "applying",
      });
      expect(
        events.some((event) => event.event === "database.migrations.completed"),
      ).toBe(false);
      expect(JSON.stringify(events)).not.toContain(dsnFor(invalidDbName));
      const lock = await invalidClient.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(1777558586, 0) AS acquired",
      );
      expect(lock.rows[0]?.acquired).toBe(true);
      await invalidClient.query("SELECT pg_advisory_unlock(1777558586, 0)");
    } finally {
      await invalidClient.end();
      await Promise.all([
        rm(invalidLegacyMigrations, { recursive: true, force: true }),
        rm(invalidPreRedactionMigrations, { recursive: true, force: true }),
      ]);
      const cleanupAdmin = new Client({ connectionString: adminDsn() });
      await cleanupAdmin.connect();
      await cleanupAdmin.query(`DROP DATABASE IF EXISTS "${invalidDbName}"`);
      await cleanupAdmin.end();
    }
  }, 120_000);

  it("supports partitioned metric events and transcript self identity after migration", async () => {
    const userId = "partitioned-api-user";
    const partitionKey = contextPartitionKeySchema.parse("room:client-a");
    const otherPartitionKey = contextPartitionKeySchema.parse("room:client-b");
    const metricDefinitionId = newTypeId("metric_definition");
    const otherMetricDefinitionId = newTypeId("metric_definition");
    await client.query("INSERT INTO users (id) VALUES ($1)", [userId]);
    await client.query(
      `INSERT INTO partition_migration_state (user_id, state, version)
       VALUES ($1, 'migrated', 1)`,
      [userId],
    );
    await client.query(
      `INSERT INTO metric_definitions
        (id, user_id, slug, label, description, unit, aggregation_hint)
       VALUES
        ($1, $3, 'focus_minutes', 'Focus minutes',
          'Minutes of focused work', 'minutes', 'sum'),
        ($2, $3, 'private_room_score', 'Private room score',
          'A metric used only in the second room', 'points', 'avg')`,
      [metricDefinitionId, otherMetricDefinitionId, userId],
    );

    setSkipEmbeddingPersistence(true);
    try {
      const [
        { recordMetricObservations },
        { listMetrics },
        { getMetricSeries },
        { getMetricSummary, getMetricSummaries },
        { setTestDatabase },
      ] = await Promise.all([
        import("~/lib/metrics/observations"),
        import("~/lib/metrics/list"),
        import("~/lib/metrics/series"),
        import("~/lib/metrics/summary"),
        import("~/utils/db"),
      ]);
      const result = await recordMetricObservations(
        {
          userId,
          partitionKey,
          source: {
            type: "metric_push",
            externalId: "calendar:focus-session-1",
          },
          createDefinitions: false,
          events: [
            {
              eventKey: "focus-session-1",
              label: "Focus session",
              occurredAt: new Date("2026-07-13T10:00:00.000Z"),
              observations: [{ metricSlug: "focus_minutes", value: 45 }],
            },
          ],
          observations: [],
        },
        database,
      );
      expect(result).toMatchObject({ inserted: 1, errors: [] });

      const otherResult = await recordMetricObservations(
        {
          userId,
          partitionKey: otherPartitionKey,
          source: {
            type: "metric_push",
            externalId: "calendar:focus-session-2",
          },
          createDefinitions: false,
          observations: [
            {
              metricSlug: "focus_minutes",
              value: 90,
              occurredAt: new Date("2026-07-13T11:00:00.000Z"),
            },
            {
              metricSlug: "private_room_score",
              value: 7,
              occurredAt: new Date("2026-07-13T11:00:00.000Z"),
            },
          ],
        },
        database,
      );
      expect(otherResult).toMatchObject({ inserted: 2, errors: [] });

      const selfNodeId = await ensureUserSelfIdentity(
        database,
        userId,
        ["Marcel Samyn"],
        partitionKey,
      );
      const partitionedRows = await client.query<{
        source_partition: string | null;
        event_partition: string | null;
        self_partition: string | null;
        alias_partition: string | null;
      }>(
        `SELECT source.partition_key AS source_partition,
                event.partition_key AS event_partition,
                self.partition_key AS self_partition,
                alias.partition_key AS alias_partition
         FROM metric_observations observation
         JOIN sources source ON source.id = observation.source_id
         JOIN nodes event ON event.id = observation.event_node_id
         JOIN nodes self ON self.id = $1
         JOIN aliases alias ON alias.canonical_node_id = self.id
         WHERE observation.user_id = $2`,
        [selfNodeId, userId],
      );
      expect(partitionedRows.rows).toEqual([
        {
          source_partition: partitionKey,
          event_partition: partitionKey,
          self_partition: partitionKey,
          alias_partition: partitionKey,
        },
      ]);

      setTestDatabase(database);
      const [firstRoomMetrics, secondRoomMetrics, firstSummary, secondSummary] =
        await Promise.all([
          listMetrics({ userId, partitionKey }),
          listMetrics({ userId, partitionKey: otherPartitionKey }),
          getMetricSummary({
            userId,
            partitionKey,
            metricId: metricDefinitionId,
          }),
          getMetricSummary({
            userId,
            partitionKey: otherPartitionKey,
            metricId: metricDefinitionId,
          }),
        ]);
      expect(firstRoomMetrics[0]?.stats).toMatchObject({
        observationCount: 1,
        latestValue: 45,
      });
      expect(secondRoomMetrics[0]?.stats).toMatchObject({
        observationCount: 1,
        latestValue: 90,
      });
      expect(firstSummary.latest?.value).toBe(45);
      expect(secondSummary.latest?.value).toBe(90);
      const firstRoomSummaries = await getMetricSummaries({
        userId,
        partitionKey,
      });
      expect(
        firstRoomSummaries.summaries.map((summary) => summary.metricId),
      ).toEqual([metricDefinitionId]);

      const firstSeries = await getMetricSeries({
        userId,
        partitionKey,
        metricIds: [metricDefinitionId],
        from: new Date("2026-07-13T00:00:00.000Z"),
        to: new Date("2026-07-14T00:00:00.000Z"),
        bucket: "none",
      });
      expect(firstSeries.series[0]?.points).toEqual([
        { t: new Date("2026-07-13T10:00:00.000Z"), value: 45 },
      ]);
      await expect(listMetrics({ userId })).rejects.toMatchObject({
        code: "PARTITION_REQUIRED",
      });
    } finally {
      const { setTestDatabase } = await import("~/utils/db");
      setTestDatabase(null);
      resetTestOverrides();
    }
  }, 120_000);
});
