import handler from "./routes/query/change-feed";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PartitionAccessError } from "~/lib/partition-access";

const feedMocks = vi.hoisted(() => ({
  queryChangeFeed: vi.fn(),
}));

vi.mock("~/lib/query/change-feed", () => feedMocks);

describe("POST /query/change-feed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("defaults the page size and validates a complete partitioned page", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_feed",
      partitionKey: "room:client",
      limit: 2,
    }));
    feedMocks.queryChangeFeed.mockResolvedValue({
      feedSchemaEpoch: 1,
      feedEpoch: 1,
      partitionKey: "room:client",
      throughSequence: 1,
      events: [
        {
          eventId: "mcfe_test",
          userId: "user_feed",
          partitionKey: "room:client",
          feedEpoch: 1,
          sequence: 1,
          kind: "claim",
          action: "asserted",
          entityType: "claim",
          entityId: "claim_test",
          sourceId: "source_test",
          effectiveChangeTime: new Date("2026-07-13T10:00:00.000Z"),
          provenance: { sourceId: "source_test" },
          freshness: null,
          status: "active",
          payload: {},
          tieBreaker: "1:mcfe_test",
        },
      ],
      nextCursor: null,
      checkpointCursor: "v1.completed-checkpoint",
      complete: true,
      pageComplete: true,
    });

    const response = await handler({} as H3Event);

    expect(feedMocks.queryChangeFeed).toHaveBeenCalledWith({
      userId: "user_feed",
      partitionKey: "room:client",
      limit: 2,
    });
    expect(response).toMatchObject({
      feedSchemaEpoch: 1,
      throughSequence: 1,
      complete: true,
      checkpointCursor: "v1.completed-checkpoint",
    });
  });

  it("returns a typed invalid-cursor response from the query layer", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_feed",
      cursor: "not-a-cursor",
    }));

    feedMocks.queryChangeFeed.mockResolvedValue({
      feedSchemaEpoch: 1,
      feedEpoch: 1,
      partitionKey: null,
      throughSequence: 0,
      events: [],
      nextCursor: null,
      complete: false,
      pageComplete: false,
      cursorInvalid: {
        reason: "malformed",
        message: "The lifecycle-feed cursor is malformed or unsupported.",
        requestedFeedEpoch: null,
        currentFeedEpoch: 1,
        throughSequence: 0,
      },
    });

    const response = await handler({} as H3Event);
    expect(response.cursorInvalid?.reason).toBe("malformed");
    expect(feedMocks.queryChangeFeed).toHaveBeenCalled();
  });

  it("forwards an explicit head start", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_feed",
      startAt: "head",
    }));
    feedMocks.queryChangeFeed.mockResolvedValue({
      feedSchemaEpoch: 1,
      feedEpoch: 1,
      partitionKey: null,
      throughSequence: 12,
      events: [],
      nextCursor: null,
      checkpointCursor: "v1.head-checkpoint",
      complete: true,
      pageComplete: true,
    });
    await expect(handler({} as H3Event)).resolves.toMatchObject({
      events: [],
      checkpointCursor: "v1.head-checkpoint",
    });
    expect(feedMocks.queryChangeFeed).toHaveBeenCalledWith({
      userId: "user_feed",
      startAt: "head",
      limit: 100,
    });
  });

  it.each(["beginning", "head"])(
    "rejects cursor with startAt %s",
    async (startAt) => {
      vi.stubGlobal("readBody", async () => ({
        userId: "user_feed",
        cursor: "v1.checkpoint",
        startAt,
      }));
      await expect(handler({} as H3Event)).rejects.toMatchObject({
        statusCode: 400,
        data: {
          issues: [
            {
              path: ["startAt"],
              message: "Specify either cursor or startAt, not both.",
            },
          ],
        },
      });
      expect(feedMocks.queryChangeFeed).not.toHaveBeenCalled();
    },
  );

  it("maps partition access conflicts to a stable client response", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_feed",
      partitionKey: "room:client",
    }));
    feedMocks.queryChangeFeed.mockRejectedValue(
      new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "Memory partition is not active",
      ),
    );

    await expect(handler({} as H3Event)).rejects.toMatchObject({
      statusCode: 409,
      data: { code: "PARTITION_UNAUTHORIZED" },
    });
  });
});
