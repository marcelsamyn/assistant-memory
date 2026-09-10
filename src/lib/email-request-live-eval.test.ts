/**
 * Opt-in: real extraction model and migrated test database; synthetic mail only.
 * With configured MEMORY_OPENAI_* and TEST_PG_* variables, run:
 * MEMORY_LIVE_EMAIL_EVAL=1 pnpm test --run src/lib/email-request-live-eval.test.ts
 */
import type { SourceContext } from "./schemas/source-context";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { newTypeId } from "~/types/typeid";
import { setTestDatabase } from "~/utils/db";
import {
  resetTestOverrides,
  setSkipEmbeddingPersistence,
  setSkipJobEnqueue,
  setSkipSemanticSearch,
} from "~/utils/test-overrides";

const cases: {
  name: string;
  content: string;
  context: Partial<SourceContext>;
  expectedTasks: number;
}[] = [
  {
    name: "Dutch direct request without a deadline",
    content:
      "Beste Marcel, kunt u het herziene contract nakijken en uw opmerkingen doorgeven? Met vriendelijke groeten, Lena",
    context: {},
    expectedTasks: 1,
  },
  {
    name: "CC recipient is not assigned another person's request",
    content:
      "Hi Alex, please review the contract and send me your comments. Marcel is copied for information only.",
    context: {
      recipients: [
        { email: "alex@example.com", recipientRole: "to" },
        { email: "marcel@example.com", recipientRole: "cc" },
      ],
    },
    expectedTasks: 0,
  },
  {
    name: "newsletter call to action",
    content:
      "This week's news: download our report and book a consultation today!",
    context: { deliveryKind: "newsletter" },
    expectedTasks: 0,
  },
  {
    name: "automatic reply",
    content:
      "I am out of the office. Please contact Alex if you need assistance.",
    context: { deliveryKind: "auto_reply" },
    expectedTasks: 0,
  },
  {
    name: "outgoing promise remains tentative",
    content:
      "Hi Lena, I will review the revised contract and send you my comments.",
    context: {
      direction: "outgoing",
      relationship: "author",
      sender: { email: "marcel@example.com" },
      recipients: [{ email: "lena@example.com", recipientRole: "to" }],
    },
    expectedTasks: 1,
  },
  {
    name: "quoted old request is not new work",
    content:
      "Thanks, received.\n\nOn Monday Lena wrote:\n> Please review the old contract and send your comments.",
    context: {},
    expectedTasks: 0,
  },
];

describe.runIf(process.env["MEMORY_LIVE_EMAIL_EVAL"] === "1")(
  "live email interpretation",
  () => {
    const dbName = `memory_live_email_${Date.now()}`;
    const dsn = (name: string): string =>
      `postgres://${process.env["TEST_PG_USER"] ?? "postgres"}:${process.env["TEST_PG_PASSWORD"] ?? "postgres"}@${process.env["TEST_PG_HOST"] ?? "localhost"}:${process.env["TEST_PG_PORT"] ?? "5431"}/${name}`;
    let pool: Pool | undefined;
    let database: NodePgDatabase<typeof schema>;
    let extractGraph: typeof import("./extract-graph").extractGraph;

    beforeAll(async () => {
      const admin = new Client({ connectionString: dsn("postgres") });
      await admin.connect();
      try {
        await admin.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await admin.end();
      }
      pool = new Pool({ connectionString: dsn(dbName), max: 4 });
      database = drizzle(pool, { schema, casing: "snake_case" });
      await migrate(database, { migrationsFolder: "./drizzle" });
      setTestDatabase(database);
      setSkipEmbeddingPersistence(true);
      setSkipSemanticSearch(true);
      setSkipJobEnqueue(true);
      extractGraph = (await import("./extract-graph")).extractGraph;
    }, 120_000);

    afterAll(async () => {
      resetTestOverrides();
      setTestDatabase(null);
      await pool?.end();
      const admin = new Client({ connectionString: dsn("postgres") });
      await admin.connect();
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await admin.end();
      }
    });

    it.each(cases)(
      "$name",
      async ({ content, context, expectedTasks }) => {
        const userId = `user_${randomUUID()}`;
        const sourceId = newTypeId("source");
        const linkedNodeId = newTypeId("node");
        const sourceContext: SourceContext = {
          version: 1,
          sourceKind: "email",
          purpose: "Find requests addressed to the authenticated mailbox owner",
          accountId: "synthetic-mailbox",
          messageId: sourceId,
          threadId: sourceId,
          authenticatedUser: { email: "marcel@example.com", name: "Marcel" },
          sender: { email: "lena@example.com", name: "Lena" },
          recipients: [{ email: "marcel@example.com", recipientRole: "to" }],
          direction: "incoming",
          relationship: "recipient",
          deliveryKind: "person_message",
          authoredAt: "2026-09-10T08:00:00.000Z",
          currentMessageRole: "current_message",
          completeness: "complete",
          ...context,
        };
        await database.insert(schema.users).values({ id: userId });
        await database
          .insert(schema.nodes)
          .values({ id: linkedNodeId, userId, nodeType: "Document" });
        await database.insert(schema.sources).values({
          id: sourceId,
          userId,
          type: "document",
          externalId: sourceId,
          metadata: { sourceContext },
        });
        await database
          .insert(schema.sourceLinks)
          .values({ sourceId, nodeId: linkedNodeId });
        await extractGraph({
          userId,
          sourceId,
          linkedNodeId,
          sourceType: "document",
          content,
          statedAt: new Date("2026-09-10T08:00:00.000Z"),
        });
        const tasks = await database
          .select()
          .from(schema.claims)
          .where(
            and(
              eq(schema.claims.userId, userId),
              eq(schema.claims.predicate, "HAS_TASK_STATUS"),
              eq(schema.claims.status, "active"),
            ),
          );
        expect(tasks).toHaveLength(expectedTasks);
        for (const task of tasks) {
          expect(task).toMatchObject({
            assertedByKind: "assistant_inferred",
            objectValue: "pending",
            sourceId,
          });
        }
        const deadlines = await database
          .select()
          .from(schema.claims)
          .where(
            and(
              eq(schema.claims.userId, userId),
              eq(schema.claims.predicate, "DUE_ON"),
            ),
          );
        expect(deadlines).toHaveLength(0);
      },
      300_000,
    );
  },
);
