import { contextPartitionKeySchema } from "../lib/schemas/partition";
import { ChangeFeedUnavailableError, MemoryClient } from "./memory-client";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("MemoryClient.queryChangeFeed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "v1.completed-checkpoint"])(
    "accepts a completed page with checkpoint %s",
    async (checkpointCursor) => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          feedSchemaEpoch: 1,
          feedEpoch: 1,
          partitionKey: "room:a",
          throughSequence: 4,
          events: [],
          nextCursor: null,
          ...(checkpointCursor === undefined ? {} : { checkpointCursor }),
          complete: true,
          pageComplete: true,
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const client = new MemoryClient({ baseUrl: "http://memory.test" });
      const response = await client.queryChangeFeed({
        userId: "user_feed",
        partitionKey: contextPartitionKeySchema.parse("room:a"),
        cursor: "v1.cursor",
        limit: 10,
      });

      expect(response.throughSequence).toBe(4);
      expect(response.checkpointCursor).toBe(checkpointCursor);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://memory.test/query/change-feed",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            userId: "user_feed",
            partitionKey: "room:a",
            cursor: "v1.cursor",
            limit: 10,
          }),
        }),
      );
    },
  );

  it("maps an older server's missing endpoint to a typed capability error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({}),
      })),
    );

    const client = new MemoryClient({ baseUrl: "http://memory.test" });
    await expect(
      client.queryChangeFeed({ userId: "user_feed" }),
    ).rejects.toBeInstanceOf(ChangeFeedUnavailableError);
  });
});
