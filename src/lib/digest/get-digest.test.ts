import { bucketCommitments, getDigest } from "./get-digest";
import { describe, expect, it, vi } from "vitest";
import type { ContextBundle } from "~/lib/context/types";
import { newTypeId } from "~/types/typeid";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

const mocks = vi.hoisted(() => ({
  getOpenCommitments: vi.fn(),
  getMetricMovers: vi.fn(),
  queryRecentChanges: vi.fn(),
  getConversationBootstrapContext: vi.fn(),
}));

vi.mock("~/lib/query/open-commitments", () => ({
  getOpenCommitments: mocks.getOpenCommitments,
}));
vi.mock("~/lib/metrics/movers", () => ({
  getMetricMovers: mocks.getMetricMovers,
}));
vi.mock("~/lib/query/recent-changes", () => ({
  queryRecentChanges: mocks.queryRecentChanges,
}));
vi.mock("~/lib/context/assemble-bootstrap-context", () => ({
  getConversationBootstrapContext: mocks.getConversationBootstrapContext,
}));

function commitment(dueOn: string | null) {
  return {
    taskId: newTypeId("node"),
    label: `task ${dueOn}`,
    status: "pending" as const,
    owner: null,
    dueOn,
    dueTime: null,
    timeZone: null,
    dueAt: null,
    statedAt: new Date("2026-05-20T00:00:00.000Z"),
    sourceId: newTypeId("source"),
  };
}

const bundle: ContextBundle = {
  sections: [
    { kind: "pinned", content: "p", usage: "u" },
    { kind: "atlas", content: "a", usage: "u" },
    { kind: "open_commitments", content: "o", usage: "u" },
    { kind: "preferences", content: "pref", usage: "u" },
  ],
  assembledAt: new Date("2026-05-29T06:00:00.000Z"),
};

const emptyWhatsNew = { claims: [], nodes: [], sources: [] };

function resetMocks() {
  vi.clearAllMocks();
  mocks.getMetricMovers.mockResolvedValue([]);
  mocks.queryRecentChanges.mockResolvedValue(emptyWhatsNew);
  mocks.getConversationBootstrapContext.mockResolvedValue(bundle);
}

describe("getDigest", () => {
  it("buckets dated commitments and drops undated / far-future ones", async () => {
    resetMocks();
    mocks.getOpenCommitments.mockResolvedValue([
      commitment("2026-05-28"), // overdue
      commitment("2026-05-29"), // due today
      commitment("2026-06-02"), // upcoming (within 7d)
      commitment("2026-07-01"), // beyond horizon → dropped
      commitment(null), // undated → dropped
    ]);

    const digest = await getDigest({
      userId: "user_digest",
      date: "2026-05-29",
      timeZone: "UTC",
    });

    expect(digest.commitments.overdue.map((c) => c.dueOn)).toEqual([
      "2026-05-28",
    ]);
    expect(digest.commitments.dueToday.map((c) => c.dueOn)).toEqual([
      "2026-05-29",
    ]);
    expect(digest.commitments.upcoming.map((c) => c.dueOn)).toEqual([
      "2026-06-02",
    ]);
  });

  it("defaults `since` to local start-of-day and includes the pinned subset", async () => {
    resetMocks();
    mocks.getOpenCommitments.mockResolvedValue([]);

    const digest = await getDigest({
      userId: "user_digest",
      date: "2026-05-29",
      timeZone: "America/New_York",
    });

    // 2026-05-29 00:00 EDT == 04:00 UTC
    expect(digest.since.toISOString()).toBe("2026-05-29T04:00:00.000Z");
    expect(mocks.queryRecentChanges).toHaveBeenCalledWith({
      userId: "user_digest",
      since: "2026-05-29T04:00:00.000Z",
      limit: 50,
    });
    expect(digest.pinned?.sections.map((s) => s.kind)).toEqual([
      "pinned",
      "preferences",
    ]);
  });

  it("honors an explicit `since` and omits pinned when disabled", async () => {
    resetMocks();
    mocks.getOpenCommitments.mockResolvedValue([]);

    const digest = await getDigest({
      userId: "user_digest",
      date: "2026-05-29",
      timeZone: "UTC",
      since: new Date("2026-05-25T00:00:00.000Z"),
      includePinned: false,
      metricMoverLimit: 5,
      whatsNewLimit: 20,
    });

    expect(digest.pinned).toBeUndefined();
    expect(mocks.getConversationBootstrapContext).not.toHaveBeenCalled();
    expect(mocks.getMetricMovers).toHaveBeenCalledWith({
      userId: "user_digest",
      limit: 5,
    });
    expect(mocks.queryRecentChanges).toHaveBeenCalledWith({
      userId: "user_digest",
      since: "2026-05-25T00:00:00.000Z",
      limit: 20,
    });
  });
});

function timedCommitment(partial: Partial<OpenCommitment> & { label: string }): OpenCommitment {
  return {
    taskId: "node_x" as OpenCommitment["taskId"],
    status: "pending",
    owner: null,
    dueOn: null,
    dueTime: null,
    timeZone: null,
    dueAt: null,
    statedAt: new Date("2026-06-10T00:00:00Z"),
    sourceId: "source_x" as OpenCommitment["sourceId"],
    ...partial,
  };
}

describe("bucketCommitments (instant-aware)", () => {
  const date = "2026-06-10";
  const tz = "America/New_York";

  it("moves a timed task to overdue once its instant passes now", () => {
    const due9am = timedCommitment({ label: "9am", dueOn: "2026-06-10", dueTime: "09:00", timeZone: tz, dueAt: new Date("2026-06-10T13:00:00Z") });
    // now = 10:00 ET = 14:00Z → 9am task is overdue
    const after = bucketCommitments([due9am], date, tz, 7, new Date("2026-06-10T14:00:00Z"));
    expect(after.overdue.map((c) => c.label)).toEqual(["9am"]);
    expect(after.dueToday).toEqual([]);
    // now = 08:00 ET = 12:00Z → still due today
    const before = bucketCommitments([due9am], date, tz, 7, new Date("2026-06-10T12:00:00Z"));
    expect(before.dueToday.map((c) => c.label)).toEqual(["9am"]);
    expect(before.overdue).toEqual([]);
  });

  it("keeps date-only tasks on calendar-day comparison", () => {
    const today = timedCommitment({ label: "today", dueOn: "2026-06-10" });
    const yesterday = timedCommitment({ label: "yest", dueOn: "2026-06-09" });
    const soon = timedCommitment({ label: "soon", dueOn: "2026-06-12" });
    const res = bucketCommitments([today, yesterday, soon], date, tz, 7, new Date("2026-06-10T14:00:00Z"));
    expect(res.dueToday.map((c) => c.label)).toEqual(["today"]);
    expect(res.overdue.map((c) => c.label)).toEqual(["yest"]);
    expect(res.upcoming.map((c) => c.label)).toEqual(["soon"]);
  });

  it("buckets a future timed task as upcoming", () => {
    const tomorrow = timedCommitment({ label: "tom", dueOn: "2026-06-11", dueTime: "09:00", timeZone: tz, dueAt: new Date("2026-06-11T13:00:00Z") });
    const res = bucketCommitments([tomorrow], date, tz, 7, new Date("2026-06-10T14:00:00Z"));
    expect(res.upcoming.map((c) => c.label)).toEqual(["tom"]);
  });
});
