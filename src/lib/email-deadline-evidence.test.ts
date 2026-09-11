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
    "Antwoord uiterlijk voor 15 september 2026.",
    "Antwoord uiterlijk tegen 15 september 2026.",
    "De deadline is 15 september 2026.",
    "Deadline voor 15 september 2026.",
    "Deadline tegen 15 september 2026.",
    "Antwoord ten laatste op 15 september 2026.",
    "Antwoord ten laatste tegen 15 september 2026.",
    "Antwoord ten laatste voor 15 september 2026.",
    "Antwoord ten laatste vóór 15 september 2026.",
    "Antwoord vóór 15/09/2026.",
    "Date limite : au plus tard le 15 septembre 2026.",
    "Bitte bis zum 15. September 2026 antworten.",
    "Bitte spätestens am 15. September 2026 antworten.",
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
    ["Maak de agenda voor 20 september 2026.", "2026-09-20"],
    ["Plan het overleg voor 15 september 2026.", "2026-09-15"],
    ["Plan het overleg op 15 september 2026.", "2026-09-15"],
    ["Reserveer een tafel tegen 15 september 2026.", "2026-09-15"],
    ["Antwoord tegen 15 september 2026.", "2026-09-15"],
    ["Antwoord tegen 2026-09-15.", "2026-09-15"],
    ["Antwoord niet uiterlijk tegen 15 september 2026.", "2026-09-15"],
    ["Antwoord pas ten laatste tegen 15 september 2026.", "2026-09-15"],
    ["Prepare the agenda for September 15, 2026.", "2026-09-15"],
    ["The meeting is on September 15, 2026.", "2026-09-15"],
    ["Préparez l'agenda pour le 15 septembre 2026.", "2026-09-15"],
    ["Bereite die Tagesordnung für den 15. September 2026 vor.", "2026-09-15"],
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
    "Er is geen deadline meer. Antwoord ten laatste morgen.",
    "There is no deadline now. Répondez au plus tard demain.",
    "There is no deadline now. Répondez avant demain.",
    "There is no deadline now. Bitte bis morgen antworten.",
    "There is no deadline now. Bitte spätestens morgen antworten.",
  ])("preserves existing dates for ambiguous evidence: %s", (excerpt) => {
    expect(hasEmailDeadlineRemovalEvidence(excerpt)).toBe(false);
  });
});
