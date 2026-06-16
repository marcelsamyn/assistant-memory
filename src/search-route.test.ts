import handler from "./routes/search.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchResponseSchema } from "~/lib/schemas/search";

const mocks = vi.hoisted(() => ({ explicitSearch: vi.fn() }));
vi.mock("~/lib/search/explicit-search", () => ({
  explicitSearch: mocks.explicitSearch,
}));

describe("POST /search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("validates the request, calls the pipeline, and round-trips the response", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "u", query: "Boox" }));
    mocks.explicitSearch.mockResolvedValue({
      query: "Boox",
      hits: [
        {
          kind: "claim",
          nodeId: "node_1",
          claimId: "claim_1",
          text: "Boox syncs",
          highlight: "<mark>Boox</mark> syncs",
          score: 0.5,
          source: { sourceId: "src_1", type: "manual" },
          statedAt: new Date("2026-05-10Z"),
        },
      ],
    });

    const response = searchResponseSchema.parse(await handler({} as H3Event));
    expect(response.hits).toHaveLength(1);
    expect(mocks.explicitSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u",
        query: "Boox",
        limit: 20,
        scope: "personal",
      }),
    );
  });

  it("rejects an empty query", async () => {
    vi.stubGlobal("readBody", async () => ({ userId: "u", query: "" }));
    await expect(handler({} as H3Event)).rejects.toThrow();
  });
});
