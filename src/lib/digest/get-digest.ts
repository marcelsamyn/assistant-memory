/**
 * Consolidated daily-digest rollup. Composes the open-commitments,
 * metric-movers, recent-changes, and bootstrap-context reads into the
 * single payload a "Today" view needs, so consumers avoid a 4-way fan-out.
 *
 * Structured data only — narrative prose stays consumer-side.
 *
 * Common aliases: getDigest, daily digest, today rollup.
 */
import { startOfDayInTimeZone } from "~/lib/time-zone";
import { getConversationBootstrapContext } from "~/lib/context/assemble-bootstrap-context";
import type { ContextBundle } from "~/lib/context/types";
import { getMetricMovers } from "~/lib/metrics/movers";
import { getOpenCommitments } from "~/lib/query/open-commitments";
import { queryRecentChanges } from "~/lib/query/recent-changes";
import {
  type DigestCommitments,
  type GetDigestRequest,
  type GetDigestResponse,
} from "~/lib/schemas/digest";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

const DEFAULT_UPCOMING_WITHIN_DAYS = 7;
const DEFAULT_WHATS_NEW_LIMIT = 50;
const PINNED_SECTION_KINDS: readonly string[] = ["pinned", "preferences"];

function shiftIsoDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Bucket dated commitments relative to the digest day. Timed tasks (those with
 * a resolved `dueAt` instant) bucket by comparing the instant to `now` and the
 * caller-zone day boundaries; date-only tasks keep calendar-day string
 * comparison. Undated tasks are omitted. Exported for direct unit testing.
 */
export function bucketCommitments(
  commitments: OpenCommitment[],
  date: string,
  timeZone: string,
  upcomingWithinDays: number,
  now: Date,
): DigestCommitments {
  const upcomingUntil = shiftIsoDate(date, upcomingWithinDays);
  const todayEnd = startOfDayInTimeZone(shiftIsoDate(date, 1), timeZone);
  const upcomingEndExcl = startOfDayInTimeZone(shiftIsoDate(date, upcomingWithinDays + 1), timeZone);

  const dueToday: OpenCommitment[] = [];
  const overdue: OpenCommitment[] = [];
  const upcoming: OpenCommitment[] = [];

  for (const commitment of commitments) {
    if (commitment.dueAt !== null) {
      const at = commitment.dueAt.getTime();
      if (at < now.getTime()) overdue.push(commitment);
      else if (at < todayEnd.getTime()) dueToday.push(commitment);
      else if (at < upcomingEndExcl.getTime()) upcoming.push(commitment);
      // Timed tasks past the upcoming horizon are intentionally omitted —
      // symmetric with date-only tasks beyond upcomingUntil below.
      continue;
    }
    const { dueOn } = commitment;
    if (dueOn === null) continue;
    if (dueOn < date) overdue.push(commitment);
    else if (dueOn === date) dueToday.push(commitment);
    else if (dueOn <= upcomingUntil) upcoming.push(commitment);
  }
  return { dueToday, overdue, upcoming };
}

function pinnedSubset(bundle: ContextBundle): ContextBundle {
  return {
    sections: bundle.sections.filter((section) =>
      PINNED_SECTION_KINDS.includes(section.kind),
    ),
    assembledAt: bundle.assembledAt,
  };
}

export async function getDigest(
  params: GetDigestRequest,
): Promise<GetDigestResponse> {
  const {
    userId,
    date,
    timeZone,
    upcomingWithinDays = DEFAULT_UPCOMING_WITHIN_DAYS,
    metricMoverLimit,
    whatsNewLimit,
    includePinned = true,
  } = params;

  const since = params.since ?? startOfDayInTimeZone(date, timeZone);

  const [commitments, metricMovers, whatsNew, bundle] = await Promise.all([
    getOpenCommitments({ userId }),
    getMetricMovers({
      userId,
      ...(metricMoverLimit !== undefined && { limit: metricMoverLimit }),
    }),
    queryRecentChanges({
      userId,
      since: since.toISOString(),
      limit: whatsNewLimit ?? DEFAULT_WHATS_NEW_LIMIT,
    }),
    includePinned
      ? getConversationBootstrapContext({ userId })
      : Promise.resolve(null),
  ]);

  return {
    date,
    timeZone,
    since,
    generatedAt: new Date(),
    commitments: bucketCommitments(commitments, date, timeZone, upcomingWithinDays, new Date()),
    metricMovers,
    whatsNew,
    ...(bundle !== null && { pinned: pinnedSubset(bundle) }),
  };
}
