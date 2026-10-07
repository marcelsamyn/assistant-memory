import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { sources, users } from "~/db/schema";
import { loadSourceConversation } from "~/lib/source-conversation";
import { newTypeId } from "~/types/typeid";

const TEST_DB_HOST = process.env["TEST_PG_HOST"] ?? "localhost";
const TEST_DB_PORT = Number(process.env["TEST_PG_PORT"] ?? 5431);
const TEST_DB_USER = process.env["TEST_PG_USER"] ?? "postgres";
const TEST_DB_PASSWORD = process.env["TEST_PG_PASSWORD"] ?? "postgres";
const TEST_DB_ADMIN_DB = process.env["TEST_PG_ADMIN_DB"] ?? "postgres";
const dsnFor = (name: string) =>
  `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${name}`;

async function isPostgresReachable(): Promise<boolean> {
  const client = new Client({ connectionString: dsnFor(TEST_DB_ADMIN_DB) });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const describeIfPostgres = (await isPostgresReachable())
  ? describe
  : describe.skip;

describeIfPostgres("loadSourceConversation", () => {
  const dbName = `memory_source_conversation_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let client: Client;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new Client({ connectionString: dsnFor(TEST_DB_ADMIN_DB) });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    client = new Client({ connectionString: dsnFor(dbName) });
    await client.connect();
    db = drizzle(client, { schema, casing: "snake_case" });
    await migrate(db, { migrationsFolder: "./drizzle" });
    await db.insert(users).values({ id: "user_a" });
  }, 120_000);

  afterAll(async () => {
    await client.end();
    const admin = new Client({ connectionString: dsnFor(TEST_DB_ADMIN_DB) });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  });

  it("reads live utterances in order with the parent's origin", async () => {
    const parentId = newTypeId("source");
    const speakerNodeId = newTypeId("node");
    const utterance = (
      index: number,
      metadata: Record<string, unknown>,
    ): typeof sources.$inferInsert => ({
      userId: "user_a",
      type: "conversation_message",
      externalId: `meet-1:${index}`,
      parentSource: parentId,
      metadata,
    });
    await db.insert(sources).values({
      id: parentId,
      userId: "user_a",
      type: "meeting_transcript",
      externalId: "meet-1",
      metadata: { sourceKind: "google_meet" },
    });
    await db.insert(sources).values([
      utterance(1, {
        rawContent: "I'll send the deck.",
        speakerLabel: "Bob",
        speakerNodeId,
        timestamp: "2026-10-01T09:00:00.000Z",
      }),
      utterance(0, {
        rawContent: "Where are we?",
        speakerLabel: "Marcel",
        timestamp: "2026-10-01T09:02:00.000Z",
      }),
      utterance(2, { rawContent: "Deleted line", speakerLabel: "Bob" }),
    ]);
    await db
      .update(sources)
      .set({ deletedAt: new Date() })
      .where(eq(sources.externalId, "meet-1:2"));

    const conversation = await loadSourceConversation(db, "user_a", {
      sourceId: parentId,
      type: "meeting_transcript",
    });

    expect(conversation).toEqual({
      sourceKind: "google_meet",
      messages: [
        expect.objectContaining({
          speaker: "Marcel",
          speakerNodeId: null,
          text: "Where are we?",
        }),
        expect.objectContaining({
          speaker: "Bob",
          speakerNodeId,
          timestamp: new Date("2026-10-01T09:00:00.000Z"),
          text: "I'll send the deck.",
        }),
      ],
    });
  });

  it("returns null for a source without child messages", async () => {
    const documentId = newTypeId("source");
    await db.insert(sources).values({
      id: documentId,
      userId: "user_a",
      type: "document",
      externalId: "doc-1",
      metadata: { rawContent: "Plain document" },
    });

    await expect(
      loadSourceConversation(db, "user_a", {
        sourceId: documentId,
        type: "document",
      }),
    ).resolves.toBeNull();
  });
});
