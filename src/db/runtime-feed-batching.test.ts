import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const host = process.env["TEST_PG_HOST"] ?? "localhost";
const port = Number(process.env["TEST_PG_PORT"] ?? 5431);
const user = process.env["TEST_PG_USER"] ?? "postgres";
const password = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const adminDb = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";
const dsnFor = (name: string): string =>
  `postgres://${user}:${password}@${host}:${port}/${name}`;

async function reachable(): Promise<boolean> {
  const client = new Client({ connectionString: dsnFor(adminDb) });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end();
  }
}

const describeWithPostgres = (await reachable()) ? describe : describe.skip;

describeWithPostgres("statement-batched runtime change feed", () => {
  const dbName = `memory_feed_batch_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: dsnFor(adminDb) });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  });

  afterAll(async () => {
    await client?.end();
    const admin = new Client({ connectionString: dsnFor(adminDb) });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });

  it("updates the head once per bulk statement and exposes events before commit", async () => {
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO users (id) VALUES ('batch');
        CREATE TEMP TABLE head_updates (id text) ON COMMIT DROP;
        CREATE FUNCTION pg_temp.count_head_updates() RETURNS trigger AS $fn$
        BEGIN INSERT INTO head_updates VALUES (NEW.id); RETURN NEW; END;
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER count_head_updates AFTER UPDATE ON memory_change_feed_heads
        FOR EACH ROW EXECUTE FUNCTION pg_temp.count_head_updates();
        INSERT INTO nodes (id, user_id, node_type)
        SELECT 'node-' || n, 'batch', 'Person' FROM generate_series(1, 128) n;
      `);
      expect(
        (await client.query("SELECT count(*)::int AS count FROM head_updates"))
          .rows,
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM memory_change_feed_events WHERE user_id = 'batch'",
          )
        ).rows,
      ).toEqual([{ count: 128 }]);
      await client.query(
        "UPDATE nodes SET node_type = 'Concept' WHERE user_id = 'batch'",
      );
      await client.query("DELETE FROM nodes WHERE user_id = 'batch'");
      expect(
        (await client.query("SELECT count(*)::int AS count FROM head_updates"))
          .rows,
      ).toEqual([{ count: 3 }]);
      expect(
        (
          await client.query(
            "SELECT next_sequence::int FROM memory_change_feed_heads WHERE user_id = 'batch'",
          )
        ).rows,
      ).toEqual([{ next_sequence: 385 }]);
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM memory_change_feed_events WHERE user_id = 'batch' AND action = 'tombstone' AND payload = '{}' AND provenance = '{}' AND status IS NULL",
          )
        ).rows,
      ).toEqual([{ count: 128 }]);
    } finally {
      await client.query("ROLLBACK");
    }
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM memory_change_feed_events WHERE user_id = 'batch'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM memory_change_feed_heads WHERE user_id = 'batch'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it("matches the original emitter across all tables, upserts, nested writes, and cascades", async () => {
    const original = await readFile(
      "drizzle/0029_calm_lifecycle_feed.sql",
      "utf8",
    );
    const start = original.indexOf(
      "CREATE FUNCTION emit_memory_change_feed_event()",
    );
    const end = original.indexOf("--> statement-breakpoint", start);
    const originalEmitter = original
      .slice(start, end)
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    const mutations = `
      INSERT INTO nodes (id, user_id, node_type) VALUES ('node-a', 'equivalence', 'Person'), ('node-b', 'equivalence', 'Person');
      INSERT INTO sources (id, user_id, type, external_id) VALUES ('source-a', 'equivalence', 'document', 'a'), ('source-b', 'equivalence', 'document', 'b');
      INSERT INTO source_links (id, source_id, node_id) VALUES ('link-a', 'source-a', 'node-a'), ('link-b', 'source-b', 'node-b');
      INSERT INTO claims (id, user_id, subject_node_id, object_node_id, predicate, statement, source_id, asserted_by_kind, stated_at)
      VALUES ('claim-a', 'equivalence', 'node-a', 'node-b', 'ASSIGNED_TO', 'A task', 'source-a', 'user', now()),
      ('claim-b', 'equivalence', 'node-b', 'node-a', 'RELATED_TO', 'A relation', 'source-b', 'user', now());
      INSERT INTO node_redirects (user_id, from_node_id, to_node_id) VALUES ('equivalence', 'node-a', 'node-b');
      UPDATE claims SET status = 'superseded' WHERE user_id = 'equivalence';
      UPDATE sources SET status = 'completed', last_ingested_at = now() WHERE user_id = 'equivalence';
      INSERT INTO nodes (id, user_id, node_type) VALUES ('node-a', 'equivalence', 'Concept'), ('node-c', 'equivalence', 'Person')
      ON CONFLICT (id) DO UPDATE SET node_type = EXCLUDED.node_type;
      UPDATE node_redirects SET to_node_id = 'node-c' WHERE user_id = 'equivalence';
      UPDATE source_links SET node_id = 'node-c' WHERE id = 'link-b';
      DELETE FROM sources WHERE user_id = 'equivalence';
      DELETE FROM node_redirects WHERE user_id = 'equivalence';
      DELETE FROM nodes WHERE user_id = 'equivalence';
    `;
    await client.query("BEGIN");
    try {
      await client.query("INSERT INTO users (id) VALUES ('equivalence')");
      // A nested statement executes while the outer node statement has pending events.
      await client.query(`
        CREATE FUNCTION pg_temp.nested_node_write() RETURNS trigger AS $fn$
        BEGIN
          IF NEW.id = 'node-b' THEN
            INSERT INTO nodes (id, user_id, node_type) VALUES ('node-nested', NEW.user_id, 'Concept');
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER z_nested_node_write AFTER INSERT ON nodes
        FOR EACH ROW EXECUTE FUNCTION pg_temp.nested_node_write();
        SAVEPOINT comparison;
      `);
      await client.query(mutations);
      const batched = (
        await client.query(
          "SELECT * FROM memory_change_feed_events WHERE user_id = 'equivalence' ORDER BY sequence",
        )
      ).rows;
      expect(batched.length).toBeGreaterThan(30);
      await client.query("ROLLBACK TO SAVEPOINT comparison");
      await client.query(originalEmitter);
      await client.query(mutations);
      const originalEvents = (
        await client.query(
          "SELECT * FROM memory_change_feed_events WHERE user_id = 'equivalence' ORDER BY sequence",
        )
      ).rows;
      expect(batched).toEqual(originalEvents);
    } finally {
      await client.query("ROLLBACK");
    }
  });

  it("serializes sequence allocation until the earlier transaction commits", async () => {
    const second = new Client({ connectionString: dsnFor(dbName) });
    await second.connect();
    await client.query("INSERT INTO users (id) VALUES ('concurrent')");
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO nodes (id, user_id, node_type) VALUES ('first-a', 'concurrent', 'Person'), ('first-b', 'concurrent', 'Person')",
      );
      await second.query("SET lock_timeout = '150ms'");
      await expect(
        second.query(
          "INSERT INTO nodes (id, user_id, node_type) VALUES ('second', 'concurrent', 'Person')",
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(
        (
          await second.query(
            "SELECT count(*)::int AS count FROM memory_change_feed_events WHERE user_id = 'concurrent'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await client.query("COMMIT");
      await second.query(
        "INSERT INTO nodes (id, user_id, node_type) VALUES ('second', 'concurrent', 'Person')",
      );
      expect(
        (
          await second.query(
            "SELECT entity_id, sequence::int FROM memory_change_feed_events WHERE user_id = 'concurrent' ORDER BY sequence",
          )
        ).rows,
      ).toEqual([
        { entity_id: "first-a", sequence: 1 },
        { entity_id: "first-b", sequence: 2 },
        { entity_id: "second", sequence: 3 },
      ]);
    } finally {
      await client.query("ROLLBACK");
      await second.end();
    }
  });
});
