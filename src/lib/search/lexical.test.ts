import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedTestDb, isServerReachable } from "./test-db";
import { findClaimsByLexical, findNodesByLexical } from "~/lib/graph";
import { nodes, nodeMetadata, claims, sources, users } from "~/db/schema";
import { newTypeId } from "~/types/typeid";
import type { MigratedTestDb } from "./test-db";

const SERVER = await isServerReachable();
const d = SERVER ? describe : describe.skip;

d("lexical retrieval", () => {
  let h: MigratedTestDb;
  const userId = "user_lex";

  beforeAll(async () => {
    h = await createMigratedTestDb(
      `memory_lex_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    );
    const { db } = h;
    await db.insert(users).values({ id: userId });

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
  });

  afterAll(async () => {
    await h.drop();
  });

  it("matches an exact keyword and returns a highlight", async () => {
    const rows = await findClaimsByLexical({ userId, query: "Boox", limit: 10 });
    expect(rows.length).toBeGreaterThan(0);
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
      statedBetween: { from: new Date("2026-05-01Z"), to: new Date("2026-05-31Z") },
    });
    expect(inRange.length).toBeGreaterThan(0);
    const outOfRange = await findClaimsByLexical({
      userId,
      query: "Boox",
      statedBetween: { from: new Date("2026-01-01Z"), to: new Date("2026-02-01Z") },
    });
    expect(outOfRange.length).toBe(0);
  });

  it("does not return reference claims for a personal query", async () => {
    const rows = await findClaimsByLexical({ userId, query: "Boox" });
    expect(rows.every((r) => r.scope === "personal")).toBe(true);
  });
});
