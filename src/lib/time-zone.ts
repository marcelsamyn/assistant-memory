/**
 * IANA time-zone helpers for resolving a local calendar date and time to a UTC
 * instant, without pulling in a date library.
 *
 * Common aliases: time zone, timezone, IANA zone, UTC instant, local time.
 */

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset (local − UTC) in milliseconds for `timeZone` at the given instant. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const lookup: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of parts) lookup[part.type] = part.value;

  const asUtc = Date.UTC(
    Number(lookup.year),
    Number(lookup.month) - 1,
    Number(lookup.day),
    Number(lookup.hour),
    Number(lookup.minute),
    Number(lookup.second),
  );
  return asUtc - instant.getTime();
}

/** UTC instant for `time` (HH:mm) local on `date` (YYYY-MM-DD) in `timeZone`. */
export function instantFromLocalTime(
  date: string,
  time: string,
  timeZone: string,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = Date.UTC(year!, month! - 1, day!, hour!, minute!, 0);
  const offset = zoneOffsetMs(new Date(utcGuess), timeZone);
  return new Date(utcGuess - offset);
}

/** UTC instant for 00:00:00 local time on `date` (YYYY-MM-DD) in `timeZone`. */
export function startOfDayInTimeZone(date: string, timeZone: string): Date {
  return instantFromLocalTime(date, "00:00", timeZone);
}
