import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryClient } from "./memory-client";

describe("MemoryClient.search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /search and parses the hit-shaped response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        query: "Boox",
        hits: [
          {
            kind: "node",
            nodeId: "node_1",
            text: "Boox",
            highlight: "<mark>Boox</mark>",
            score: 0.4,
            source: { sourceId: "src_1", type: "manual" },
          },
        ],
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    const res = await client.search({ userId: "u", query: "Boox" });

    expect(res.hits[0]!.nodeId).toBe("node_1");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://memory.test/search",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
