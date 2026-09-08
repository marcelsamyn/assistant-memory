import { MemoryClient } from "./memory-client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MemoryClient.search", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to /search and parses the hit-shaped response", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(input).toBe("http://memory.test/search");
        expect(init).toEqual(expect.objectContaining({ method: "POST" }));

        return {
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
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    const res = await client.search({
      userId: "u",
      partitionKey: "opaque:client-a",
      query: "Boox",
    });

    expect(res.hits[0]!.nodeId).toBe("node_1");
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      userId: "u",
      partitionKey: "opaque:client-a",
      query: "Boox",
    });
  });
});
