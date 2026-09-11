import {
  hasEmailDeadlineEvidence,
  hasEmailDeadlineRemovalEvidence,
} from "./email-deadline-evidence";
import { describe, expect, it } from "vitest";

describe("grounded email deadlines", () => {
  it.each([
    "Please reply by 2026-09-15.",
    "Please reply by September 15, 2026.",
    "Please reply by 15 September 2026.",
    "Antwoord uiterlijk 15 september 2026.",
    "Antwoord vóór 15/09/2026.",
    "Date limite : au plus tard le 15 septembre 2026.",
  ])("accepts the explicit matching date: %s", (statement) => {
    expect(
      hasEmailDeadlineEvidence({
        dateLabel: "2026-09-15",
        statement,
        requestExcerpt: `Please review this request. ${statement}`,
      }),
    ).toBe(true);
  });

  it.each([
    ["Please reply.", "2026-09-15"],
    ["Please review https://reports.test/by/2026-09-15.", "2026-09-15"],
    ["Please review report-by-2026-09-15.", "2026-09-15"],
    ["Please reply by 2026-09-15.", "2026-09-16"],
    ["Please review the invoice dated 15 September 2026.", "2026-09-15"],
    ["This is not due by 2026-09-15.", "2026-09-15"],
    ["Please reply by 03/04/2026.", "2026-04-03"],
    ["Please reply by 2026-02-29.", "2026-02-29"],
    ["Please reply by ticket2026-09-15.", "2026-09-15"],
    ["Please reply by tomorrow.", "2026-09-15"],
  ])("leaves unsupported evidence undated: %s", (statement, dateLabel) => {
    expect(
      hasEmailDeadlineEvidence({
        dateLabel,
        statement,
        requestExcerpt: statement,
      }),
    ).toBe(false);
  });

  it("rejects a deadline quote absent from the verified request excerpt", () => {
    expect(
      hasEmailDeadlineEvidence({
        dateLabel: "2026-09-15",
        statement: "Please reply by 2026-09-15.",
        requestExcerpt: "Please reply when you can.",
      }),
    ).toBe(false);
  });
});

describe("explicit email deadline removal", () => {
  it.each([
    "Please review the revised contract. There is no deadline now.",
    "The deadline has been removed.",
    "The due date is cancelled.",
    "There is no longer a deadline.",
    "This task no longer has a deadline.",
    "Bekijk de nieuwe voorwaarden. Er is geen deadline meer.",
    "De deadline is vervallen.",
  ])("accepts unconditional removal: %s", (excerpt) => {
    expect(hasEmailDeadlineRemovalEvidence(excerpt)).toBe(true);
  });

  it.each([
    "Please review the revised contract.",
    "It is not due by 2026-09-15.",
    "The deadline has not been removed.",
    "There is no deadline now?",
    "If there is no deadline now, please tell me.",
    "The deadline has been removed from the calendar.",
    "There is no deadline now. Please finish by tomorrow.",
    "There is no deadline now. The new due date is Friday.",
    "Er is geen deadline meer. Antwoord uiterlijk morgen.",
  ])("preserves existing dates for ambiguous evidence: %s", (excerpt) => {
    expect(hasEmailDeadlineRemovalEvidence(excerpt)).toBe(false);
  });
});
