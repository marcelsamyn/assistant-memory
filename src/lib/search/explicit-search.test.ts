// src/lib/search/explicit-search.test.ts
import { explicitSearch } from "./explicit-search";
import "dotenv/config";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateTextEmbedding: vi.fn(),
  findSimilarNodes: vi.fn(),
  findSimilarClaims: vi.fn(),
  findNodesByLexical: vi.fn(),
  findClaimsByLexical: vi.fn(),
}));

vi.mock("~/lib/graph", () => ({
  generateTextEmbedding: mocks.generateTextEmbedding,
  findSimilarNodes: mocks.findSimilarNodes,
  findSimilarClaims: mocks.findSimilarClaims,
  findNodesByLexical: mocks.findNodesByLexical,
  findClaimsByLexical: mocks.findClaimsByLexical,
}));

// Stub hydrator: maps src_1 -> a manual source. Injected so the pipeline never
// touches the DB in this unit test.
const stubHydrate = async (ids: string[]) =>
  new Map(ids.map((id) => [id, { sourceId: id, type: "manual" as const }]));

describe("explicitSearch", () => {
  afterEach(() => vi.clearAllMocks());

  it("fuses legs, builds hits, and orders by fused score", async () => {
    mocks.generateTextEmbedding.mockResolvedValue([0.1, 0.2]);
    mocks.findSimilarNodes.mockResolvedValue([
      {
        id: "node_1",
        type: "Object",
        label: "Boox",
        description: null,
        timestamp: new Date(),
        similarity: 0.9,
      },
    ]);
    mocks.findNodesByLexical.mockResolvedValue([
      {
        id: "node_1",
        type: "Object",
        label: "Boox",
        description: null,
        timestamp: new Date(),
        similarity: 1,
        highlight: "<mark>Boox</mark>",
      },
    ]);
    mocks.findSimilarClaims.mockResolvedValue([]);
    mocks.findClaimsByLexical.mockResolvedValue([
      {
        id: "claim_1",
        subjectNodeId: "node_1",
        objectNodeId: null,
        objectValue: "v",
        subjectLabel: "Boox",
        objectLabel: null,
        predicate: "HAS_ATTRIBUTE",
        statement: "Boox syncs",
        description: null,
        sourceId: "src_1",
        scope: "personal",
        assertedByKind: "user",
        assertedByNodeId: null,
        status: "active",
        statedAt: new Date("2026-05-10Z"),
        timestamp: new Date(),
        similarity: 1,
        highlight: "<mark>Boox</mark> syncs",
      },
    ]);

    const result = await explicitSearch(
      { userId: "u", query: "Boox", limit: 20, scope: "personal" },
      stubHydrate,
    );

    // node_1 appears in both node legs (high fused score) -> first.
    expect(result.hits[0]!.kind).toBe("node");
    expect(result.hits[0]!.nodeId).toBe("node_1");
    expect(result.hits[0]!.source).toBeDefined(); // node provenance is a placeholder in v1
    const claimHit = result.hits.find((h) => h.kind === "claim")!;
    expect(claimHit.nodeId).toBe("node_1"); // owning subject
    expect(claimHit.claimId).toBe("claim_1");
    expect(claimHit.highlight).toContain("<mark>");
    expect(claimHit.source.type).toBe("manual"); // from stubHydrate
  });

  it("forwards scope to every retrieval leg", async () => {
    mocks.generateTextEmbedding.mockResolvedValue([0.1]);
    mocks.findSimilarNodes.mockResolvedValue([]);
    mocks.findNodesByLexical.mockResolvedValue([]);
    mocks.findSimilarClaims.mockResolvedValue([]);
    mocks.findClaimsByLexical.mockResolvedValue([]);

    await explicitSearch(
      { userId: "u", query: "x", limit: 20, scope: "reference" },
      stubHydrate,
    );

    expect(mocks.findSimilarClaims).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "reference" }),
    );
    expect(mocks.findNodesByLexical).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "reference" }),
    );
  });
});
