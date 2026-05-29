import handler from "./routes/digest.post";
import type { H3Event } from "h3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GetDigestResponse } from "~/lib/schemas/digest";
import { getDigestResponseSchema } from "~/lib/schemas/digest";
import { newTypeId } from "~/types/typeid";

const mocks = vi.hoisted(() => ({ getDigest: vi.fn() }));
vi.mock("~/lib/digest/get-digest", () => ({ getDigest: mocks.getDigest }));

describe("POST /digest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("validates the request and round-trips a full digest through the response schema", async () => {
    const taskId = newTypeId("node");
    const metricId = newTypeId("metric_definition");
    const since = new Date("2026-05-29T00:00:00.000Z");

    const digest: GetDigestResponse = {
      date: "2026-05-29",
      timeZone: "UTC",
      since,
      generatedAt: new Date("2026-05-29T07:00:00.000Z"),
      commitments: {
        dueToday: [
          {
            taskId,
            label: "Send the spec",
            status: "pending",
            owner: null,
            dueOn: "2026-05-29",
            statedAt: new Date("2026-05-20T00:00:00.000Z"),
            sourceId: newTypeId("source"),
          },
        ],
        overdue: [],
        upcoming: [],
      },
      metricMovers: [
        {
          metricId,
          slug: "readiness",
          label: "Oura readiness",
          unit: "score",
          latestValue: 78,
          delta: -7,
          direction: "down",
          window: "7d",
        },
      ],
      whatsNew: { claims: [], nodes: [], sources: [] },
      pinned: {
        sections: [{ kind: "pinned", content: "c", usage: "u" }],
        assembledAt: new Date("2026-05-29T06:00:00.000Z"),
      },
    };

    vi.stubGlobal("readBody", async () => ({
      userId: "user_digest",
      date: "2026-05-29",
      timeZone: "UTC",
    }));
    mocks.getDigest.mockResolvedValue(digest);

    const response = getDigestResponseSchema.parse(
      await handler({} as H3Event),
    );

    expect(mocks.getDigest).toHaveBeenCalledWith({
      userId: "user_digest",
      date: "2026-05-29",
      timeZone: "UTC",
    });
    expect(response.commitments.dueToday[0]!.dueOn).toBe("2026-05-29");
    expect(response.metricMovers[0]!.direction).toBe("down");
    expect(response.pinned?.sections[0]!.kind).toBe("pinned");
  });

  it("rejects an invalid time zone before calling the digest assembler", async () => {
    vi.stubGlobal("readBody", async () => ({
      userId: "user_digest",
      date: "2026-05-29",
      timeZone: "Not/AZone",
    }));

    await expect(handler({} as H3Event)).rejects.toThrow();
    expect(mocks.getDigest).not.toHaveBeenCalled();
  });
});
