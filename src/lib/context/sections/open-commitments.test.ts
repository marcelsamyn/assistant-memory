import { describe, expect, it } from "vitest";
import { renderLine } from "./open-commitments";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

function c(partial: Partial<OpenCommitment> & { label: string }): OpenCommitment {
  return {
    taskId: "node_x" as OpenCommitment["taskId"],
    status: "pending", owner: null, dueOn: null, dueTime: null, timeZone: null,
    dueAt: null, statedAt: new Date(), sourceId: "source_x" as OpenCommitment["sourceId"],
    ...partial,
  };
}

describe("renderLine", () => {
  it("renders date only when no time", () => {
    expect(renderLine(c({ label: "A", dueOn: "2026-06-10" }))).toContain("due=2026-06-10");
  });
  it("renders date + time + zone when timed", () => {
    const line = renderLine(c({ label: "A", dueOn: "2026-06-10", dueTime: "17:00", timeZone: "America/New_York" }));
    expect(line).toContain("due=2026-06-10 17:00 America/New_York");
  });
  it("omits due entirely when undated", () => {
    expect(renderLine(c({ label: "A" }))).not.toContain("due=");
  });
});
