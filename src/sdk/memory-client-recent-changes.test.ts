import { MemoryClient } from "./memory-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newTypeId } from "~/types/typeid";

describe("MemoryClient.queryRecentChanges", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "2026-05-28T12:00:00.000Z"])(
    "preserves authored dates and accepts change time %s",
    async (changedAt) => {
      const statedAt = "2026-01-05T00:00:00.000Z";
      const firstSeenAt = "2026-01-02T00:00:00.000Z";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            claims: [
              {
                id: newTypeId("claim"),
                predicate: "HAS_GOAL",
                statement: "Finish the draft.",
                subjectLabel: "Draft goal",
                objectLabel: "finish draft by July 1",
                sourceId: newTypeId("source"),
                statedAt,
                changeKind: "updated",
                assertedByKind: "user",
                ...(changedAt === undefined ? {} : { changedAt }),
              },
            ],
            nodes: [
              {
                id: newTypeId("node"),
                nodeType: "Concept",
                label: "Draft goal",
                changeKind: "updated",
                firstSeenAt,
                ...(changedAt === undefined ? {} : { changedAt }),
              },
            ],
            sources: [],
          }),
        })),
      );

      const client = new MemoryClient({ baseUrl: "http://memory.test" });
      const response = await client.queryRecentChanges({
        userId: "user_recent_changes",
        since: "2026-05-20T00:00:00.000Z",
        limit: 10,
      });
      const expectedChange = changedAt ? new Date(changedAt) : undefined;
      expect(response.claims[0]?.changedAt).toEqual(expectedChange);
      expect(response.claims[0]?.statedAt).toEqual(new Date(statedAt));
      expect(response.nodes[0]?.changedAt).toEqual(expectedChange);
      expect(response.nodes[0]?.firstSeenAt).toEqual(new Date(firstSeenAt));
    },
  );
});
