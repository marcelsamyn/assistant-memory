import handler from "./routes/query/recent-changes";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTypeId } from "~/types/typeid";

const recentChangesMocks = vi.hoisted(() => ({
  queryRecentChanges: vi.fn(),
}));

vi.mock("~/lib/query/recent-changes", () => recentChangesMocks);

describe("POST /query/recent-changes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("parses the request body (defaulting limit) and returns the schema-validated feed", async () => {
    const claimId = newTypeId("claim");
    const nodeId = newTypeId("node");
    const sourceId = newTypeId("source");

    vi.stubGlobal("readBody", async () => ({
      userId: "user_rc",
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-29T00:00:00.000Z",
      nodeTypes: ["Person"],
    }));

    recentChangesMocks.queryRecentChanges.mockResolvedValue({
      claims: [
        {
          id: claimId,
          predicate: "RELATED_TO",
          statement: "Lena is linked to the Book project.",
          subjectLabel: "Lena",
          objectLabel: "Book",
          sourceId,
          statedAt: new Date("2026-05-28T10:01:00.000Z"),
          changeKind: "added",
          assertedByKind: "user",
        },
      ],
      nodes: [
        {
          id: nodeId,
          nodeType: "Person",
          label: "Lena",
          changeKind: "added",
          firstSeenAt: new Date("2026-05-28T10:00:00.000Z"),
        },
      ],
      sources: [
        {
          sourceId,
          type: "conversation",
          title: "Coaching call",
          timestamp: new Date("2026-05-28T09:00:00.000Z"),
        },
      ],
    });

    const response = await handler({} as H3Event);

    // The lib receives the parsed request with `limit` defaulted by the schema.
    expect(recentChangesMocks.queryRecentChanges).toHaveBeenCalledWith({
      userId: "user_rc",
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-29T00:00:00.000Z",
      limit: 100,
      nodeTypes: ["Person"],
    });

    expect(response.claims[0]).toMatchObject({
      id: claimId,
      changeKind: "added",
      subjectLabel: "Lena",
      objectLabel: "Book",
    });
    expect(response.nodes[0]).toMatchObject({
      id: nodeId,
      changeKind: "added",
    });
    expect(response.sources[0]).toMatchObject({
      sourceId,
      title: "Coaching call",
    });
  });

  it("rejects a malformed `since` before reaching the query layer", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_rc",
      since: "2026-05-20", // date-only, not an ISO datetime
    }));

    await expect(handler({} as H3Event)).rejects.toThrow();
    expect(recentChangesMocks.queryRecentChanges).not.toHaveBeenCalled();
  });
});
