import { normalizeEmailEvidence } from "./email-request-matching";
import { isDayKey } from "./rollup/period";

function dateWords(text: string): string {
  return normalizeEmailEvidence(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A normalized date must agree with the quoted, already-validated request. */
export function hasEmailDeadlineEvidence(input: {
  dateLabel: string | undefined;
  statement: string;
  requestExcerpt: string | undefined;
}): boolean {
  const { dateLabel, statement, requestExcerpt } = input;
  if (
    dateLabel === undefined ||
    requestExcerpt === undefined ||
    !isDayKey(dateLabel)
  )
    return false;
  const quote = normalizeEmailEvidence(statement);
  if (
    quote.length === 0 ||
    !normalizeEmailEvidence(requestExcerpt).includes(quote)
  )
    return false;
  // A conservative omission is preferable to assigning a negated deadline.
  if (
    /\b(?:not|no|never|niet|geen|pas|nicht|kein)\b/u.test(
      normalizeEmailEvidence(requestExcerpt),
    )
  )
    return false;
  const date = new Date(`${dateLabel}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== dateLabel
  )
    return false;
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const forms = [dateLabel, `${year}/${month}/${day}`];
  // Without a source locale, 03/04 cannot distinguish March 4 from April 3.
  if (day > 12 || day === month) {
    forms.push(
      `${day}/${month}/${year}`,
      `${month}/${day}/${year}`,
      `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`,
      `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`,
    );
  }
  for (const locale of ["en-GB", "en-US", "nl", "fr", "de"]) {
    for (const monthStyle of ["long", "short"] as const) {
      forms.push(
        new Intl.DateTimeFormat(locale, {
          day: "numeric",
          month: monthStyle,
          year: "numeric",
          timeZone: "UTC",
        }).format(date),
      );
    }
  }
  return forms.some((form) => {
    const datePattern = dateWords(form).split(" ").join("[\\s.,/-]+");
    // Match cues in prose; punctuation in a URL or identifier is not whitespace.
    return new RegExp(
      `(?:^|\\s)(?:by|before|due(?: on| by)?|deadline(?: is| on| by)?|uiterlijk(?: op)?|tegen|vóór|voor|avant(?: le)?|au plus tard(?: le)?|bis(?: zum)?|spätestens(?: am)?)\\s+${datePattern}(?=$|[\\s.,;:!?])`,
      "u",
    ).test(quote);
  });
}
