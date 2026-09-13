import { createMigratedTestDb, isServerReachable } from "./test-db";
import type { MigratedTestDb } from "./test-db";
import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodes, nodeMetadata, claims, sources, users } from "~/db/schema";
import { findClaimsByLexical, findNodesByLexical } from "~/lib/graph";
import { newTypeId, type TypeId } from "~/types/typeid";

const SERVER = await isServerReachable();
const d = SERVER ? describe : describe.skip;

d("lexical retrieval", () => {
  let h: MigratedTestDb;
  const userId = "user_lex";
  let foreignObjectId: TypeId<"node">;

  beforeAll(async () => {
    h = await createMigratedTestDb(
      `memory_lex_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    );
    const { db } = h;
    await db.insert(users).values({ id: userId });
    await db.insert(users).values({ id: "user_lex_foreign" });

    // Source for personal claims.
    const srcId = newTypeId("source");
    await db.insert(sources).values({
      id: srcId,
      userId,
      type: "manual",
      externalId: "ext_lex_1",
      scope: "personal",
    });

    // Node "Boox Note Air" (personal via a claim referencing it).
    const booxId = newTypeId("node");
    await db.insert(nodes).values({
      id: booxId,
      userId,
      nodeType: "Object",
    });
    await db.insert(nodeMetadata).values({
      id: newTypeId("node_metadata"),
      nodeId: booxId,
      label: "Boox Note Air 4C",
      canonicalLabel: "boox note air 4c",
      description: "e-ink tablet",
    });

    // A malformed historical claim may mention the personal subject while
    // pointing at another user's object. It must not expose that endpoint.
    foreignObjectId = newTypeId("node");
    await db.insert(nodes).values({
      id: foreignObjectId,
      userId: "user_lex_foreign",
      nodeType: "Person",
    });
    await db.insert(nodeMetadata).values({
      id: newTypeId("node_metadata"),
      nodeId: foreignObjectId,
      label: "Foreign private object",
      canonicalLabel: "foreign private object",
    });

    // A claim mentioning Boox, stated 2026-05-10.
    await db.insert(claims).values({
      id: newTypeId("claim"),
      userId,
      subjectNodeId: booxId,
      objectValue: "syncs handwriting to Drive",
      predicate: "HAS_ATTRIBUTE",
      statement: "The Boox Note Air syncs handwriting to Google Drive",
      sourceId: srcId,
      scope: "personal",
      assertedByKind: "user",
      statedAt: new Date("2026-05-10T00:00:00Z"),
      status: "active",
    });
    // Seed a malformed historical row while keeping the trigger bypass
    // isolated to this fixture insert. Production writes remain guarded.
    await h.client.query(`ALTER TABLE "claims" DISABLE TRIGGER USER`);
    try {
      await db.insert(claims).values({
        id: newTypeId("claim"),
        userId,
        subjectNodeId: booxId,
        objectNodeId: foreignObjectId,
        predicate: "HAS_ATTRIBUTE",
        statement: "The Boox Note Air mentions a foreign private object",
        sourceId: srcId,
        scope: "personal",
        assertedByKind: "user",
        statedAt: new Date("2026-05-10T00:00:00Z"),
        status: "active",
      });
    } finally {
      await h.client.query(`ALTER TABLE "claims" ENABLE TRIGGER USER`);
    }
  });

  afterAll(async () => {
    await h.drop();
  });

  it("matches an exact keyword and returns a highlight", async () => {
    const rows = await findClaimsByLexical({
      userId,
      query: "Boox",
      limit: 10,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.objectNodeId === foreignObjectId)).toBe(
      false,
    );
    expect(rows[0]!.statement).toContain("Boox");
    expect(rows[0]!.highlight).toMatch(/<mark>|Boox/);
  });

  it("matches a node label via trigram despite a typo", async () => {
    const rows = await findNodesByLexical({ userId, query: "Boux", limit: 10 });
    expect(rows.some((r) => r.label === "Boox Note Air 4C")).toBe(true);
  });

  it("filters claims by stated_at range", async () => {
    const inRange = await findClaimsByLexical({
      userId,
      query: "Boox",
      statedBetween: {
        from: new Date("2026-05-01Z"),
        to: new Date("2026-05-31Z"),
      },
    });
    expect(inRange.length).toBeGreaterThan(0);
    const outOfRange = await findClaimsByLexical({
      userId,
      query: "Boox",
      statedBetween: {
        from: new Date("2026-01-01Z"),
        to: new Date("2026-02-01Z"),
      },
    });
    expect(outOfRange.length).toBe(0);
  });

  it("does not return reference claims for a personal query", async () => {
    const rows = await findClaimsByLexical({ userId, query: "Boox" });
    expect(rows.every((r) => r.scope === "personal")).toBe(true);
  });
});
