import {
  queryTimelineRequestSchema,
  queryTimelineResponseSchema,
} from "./query-timeline";
import { describe, it, expect } from "vitest";

describe("queryTimelineRequestSchema", () => {
  it("accepts minimal request with only userId", () => {
    const parsed = queryTimelineRequestSchema.parse({ userId: "user_123" });
    expect(parsed.userId).toBe("user_123");
    expect(parsed.limit).toBe(30);
    expect(parsed.offset).toBe(0);
    expect(parsed.startDate).toBeUndefined();
    expect(parsed.endDate).toBeUndefined();
    expect(parsed.nodeTypes).toBeUndefined();
  });

  it("accepts full request with all fields", () => {
    const parsed = queryTimelineRequestSchema.parse({
      userId: "user_123",
      startDate: "2025-01-15",
      endDate: "2024-10-15",
      limit: 10,
      offset: 5,
      nodeTypes: ["Person", "Event"],
    });
    expect(parsed.startDate).toBe("2025-01-15");
    expect(parsed.endDate).toBe("2024-10-15");
    expect(parsed.limit).toBe(10);
    expect(parsed.offset).toBe(5);
    expect(parsed.nodeTypes).toEqual(["Person", "Event"]);
  });

  it("rejects invalid date format", () => {
    expect(() =>
      queryTimelineRequestSchema.parse({
        userId: "user_123",
        startDate: "01-15-2025",
      }),
    ).toThrow();
  });

  it("rejects invalid nodeType", () => {
    expect(() =>
      queryTimelineRequestSchema.parse({
        userId: "user_123",
        nodeTypes: ["InvalidType"],
      }),
    ).toThrow();
  });

  it("rejects limit over 100", () => {
    expect(() =>
      queryTimelineRequestSchema.parse({
        userId: "user_123",
        limit: 101,
      }),
    ).toThrow();
  });

  it("rejects negative offset", () => {
    expect(() =>
      queryTimelineRequestSchema.parse({
        userId: "user_123",
        offset: -1,
      }),
    ).toThrow();
  });
});

describe("queryTimelineResponseSchema", () => {
  it("validates a complete response", () => {
    const response = {
      days: [
        {
          date: "2025-01-15",
          temporalNodeId: "node_01234567890123456789abcdef",
          nodeCount: 5,
          nodes: [
            {
              id: "node_abcdefghijklmnopqrstuvwxyz",
              label: "Meeting with team",
              description: "Weekly standup meeting",
              nodeType: "Event",
              predicate: "OCCURRED_ON",
              createdAt: "2025-01-15T10:00:00.000Z",
            },
          ],
        },
      ],
      totalDays: 10,
      hasMore: true,
    };
    const parsed = queryTimelineResponseSchema.parse(response);
    expect(parsed.days).toHaveLength(1);
    expect(parsed.days[0]!.nodeCount).toBe(5);
    expect(parsed.days[0]!.nodes[0]!.createdAt).toBeInstanceOf(Date);
    expect(parsed.totalDays).toBe(10);
    expect(parsed.hasMore).toBe(true);
  });

  it("validates empty response", () => {
    const parsed = queryTimelineResponseSchema.parse({
      days: [],
      totalDays: 0,
      hasMore: false,
    });
    expect(parsed.days).toEqual([]);
    expect(parsed.totalDays).toBe(0);
    expect(parsed.hasMore).toBe(false);
  });
});
