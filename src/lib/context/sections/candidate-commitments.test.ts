import { assembleCandidateCommitmentsSection } from "./candidate-commitments";
import { describe, expect, it, vi } from "vitest";
import { getCandidateCommitments } from "~/lib/query/open-commitments";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

// Mock the DB query so we can test renderLine in isolation.
vi.mock("~/lib/query/open-commitments", () => ({
  getCandidateCommitments: vi.fn(),
}));

function c(
  partial: Partial<OpenCommitment> & { label: string },
): OpenCommitment {
  return {
    taskId: "node_x" as OpenCommitment["taskId"],
    status: "pending",
    owner: null,
    dueOn: null,
    dueTime: null,
    timeZone: null,
    dueAt: null,
    statedAt: new Date(),
    sourceId: "source_x" as OpenCommitment["sourceId"],
    ...partial,
  };
}

describe("assembleCandidateCommitmentsSection renderLine", () => {
  it("renders date only when no time", async () => {
    vi.mocked(getCandidateCommitments).mockResolvedValue([
      c({ label: "Task A", dueOn: "2026-06-10" }),
    ]);
    const section = await assembleCandidateCommitmentsSection("user_1");
    expect(section?.content).toContain("due=2026-06-10");
    expect(section?.content).not.toMatch(/due=2026-06-10 \S/);
  });

  it("renders date + time + zone for a timed commitment", async () => {
    vi.mocked(getCandidateCommitments).mockResolvedValue([
      c({
        label: "Task B",
        dueOn: "2026-06-10",
        dueTime: "17:00",
        timeZone: "America/New_York",
      }),
    ]);
    const section = await assembleCandidateCommitmentsSection("user_1");
    expect(section?.content).toContain("due=2026-06-10 17:00 America/New_York");
  });

  it("omits due entirely when undated", async () => {
    vi.mocked(getCandidateCommitments).mockResolvedValue([
      c({ label: "Task C" }),
    ]);
    const section = await assembleCandidateCommitmentsSection("user_1");
    expect(section?.content).not.toContain("due=");
  });

  it("includes the task id in the line", async () => {
    vi.mocked(getCandidateCommitments).mockResolvedValue([
      c({ label: "Task D", taskId: "node_abc" as OpenCommitment["taskId"] }),
    ]);
    const section = await assembleCandidateCommitmentsSection("user_1");
    expect(section?.content).toContain("id=node_abc");
  });
});
