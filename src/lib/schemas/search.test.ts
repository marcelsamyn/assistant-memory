import { describe, expect, it } from "vitest";
import { searchRequestSchema, searchResponseSchema } from "./search";

describe("search schemas", () => {
  it("applies defaults and rejects empty query", () => {
    const parsed = searchRequestSchema.parse({ userId: "u", query: "boox" });
    expect(parsed.limit).toBe(20);
    expect(parsed.scope).toBe("personal");
    expect(() => searchRequestSchema.parse({ userId: "u", query: "" })).toThrow();
  });

  it("accepts entityTypes and statedBetween filters", () => {
    const parsed = searchRequestSchema.parse({
      userId: "u",
      query: "x",
      filters: {
        entityTypes: ["Person", "Task"],
        statedBetween: { from: "2026-05-01T00:00:00Z" },
      },
    });
    expect(parsed.filters?.entityTypes).toEqual(["Person", "Task"]);
    expect(parsed.filters?.statedBetween?.from).toBeInstanceOf(Date);
  });

  it("validates a hit-shaped response", () => {
    const ok = searchResponseSchema.parse({
      query: "x",
      hits: [
        {
          kind: "claim",
          nodeId: "node_abc",
          claimId: "claim_abc",
          text: "The Boox syncs to Drive",
          highlight: "The <mark>Boox</mark> syncs to Drive",
          score: 0.123,
          source: { sourceId: "src_abc", type: "manual" },
          statedAt: "2026-05-10T00:00:00Z",
        },
      ],
    });
    expect(ok.hits[0]!.kind).toBe("claim");
  });
});
