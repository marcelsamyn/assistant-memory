/**
 * Pure period-key math for the temporal rollup hierarchy.
 *
 * Period keys (all derived from the day-label convention used by
 * `ensureDayNode`): day `yyyy-MM-dd`, ISO week `yyyy-Www` (ISO
 * week-numbering year), month `yyyy-MM`, year `yyyy`. All functions are
 * pure and timezone-stable: day keys are parsed and re-formatted with
 * date-fns in local time, so round-trips never shift dates.
 *
 * Aliases for search: period keys, temporal hierarchy, ISO week math,
 * rollup periods.
 */
import {
  addDays,
  format,
  getISOWeek,
  getISOWeekYear,
  lastDayOfMonth,
  parse,
  setISOWeek,
  setISOWeekYear,
  startOfISOWeek,
} from "date-fns";

export type PeriodLevel = "day" | "week" | "month" | "year";

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_KEY_RE = /^(\d{4})-W(\d{2})$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const YEAR_KEY_RE = /^\d{4}$/;

const REFERENCE_DATE = new Date(2000, 0, 1);

export function periodLevelOf(key: string): PeriodLevel {
  if (DAY_KEY_RE.test(key)) return "day";
  if (WEEK_KEY_RE.test(key)) return "week";
  if (MONTH_KEY_RE.test(key)) return "month";
  if (YEAR_KEY_RE.test(key)) return "year";
  throw new Error(`Malformed period key: "${key}"`);
}

export function isDayKey(key: string): boolean {
  return DAY_KEY_RE.test(key);
}

function dayDate(dayKey: string): Date {
  return parse(dayKey, "yyyy-MM-dd", REFERENCE_DATE);
}

export function dayKeyOf(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

export function weekKeyForDay(dayKey: string): string {
  const d = dayDate(dayKey);
  const isoYear = String(getISOWeekYear(d)).padStart(4, "0");
  const isoWeek = String(getISOWeek(d)).padStart(2, "0");
  return `${isoYear}-W${isoWeek}`;
}

function mondayOfWeek(weekKey: string): Date {
  const match = WEEK_KEY_RE.exec(weekKey);
  if (!match) throw new Error(`Malformed week key: "${weekKey}"`);
  const isoYear = Number(match[1]);
  const isoWeek = Number(match[2]);
  // Anchor mid-year so week 26 always exists before the ISO fields are set.
  let d = new Date(2000, 6, 1);
  d = setISOWeekYear(d, isoYear);
  d = setISOWeek(d, isoWeek);
  return startOfISOWeek(d);
}

export function weekDayKeys(weekKey: string): string[] {
  const monday = mondayOfWeek(weekKey);
  return Array.from({ length: 7 }, (_, i) => dayKeyOf(addDays(monday, i)));
}

export function monthKeyForDay(dayKey: string): string {
  if (!DAY_KEY_RE.test(dayKey)) {
    throw new Error(`Malformed day key: "${dayKey}"`);
  }
  return dayKey.slice(0, 7);
}

export function monthKeysForWeek(weekKey: string): string[] {
  const days = weekDayKeys(weekKey);
  return [...new Set(days.map(monthKeyForDay))];
}

export function yearKeyForMonth(monthKey: string): string {
  if (!MONTH_KEY_RE.test(monthKey)) {
    throw new Error(`Malformed month key: "${monthKey}"`);
  }
  return monthKey.slice(0, 4);
}

export function monthKeysOfYear(yearKey: string): string[] {
  if (!YEAR_KEY_RE.test(yearKey)) {
    throw new Error(`Malformed year key: "${yearKey}"`);
  }
  return Array.from(
    { length: 12 },
    (_, i) => `${yearKey}-${String(i + 1).padStart(2, "0")}`,
  );
}

export interface WeekInMonth {
  weekKey: string;
  /** The subset of this week's 7 days that fall inside the month. */
  dayKeysInMonth: string[];
}

export function weeksOverlappingMonth(monthKey: string): WeekInMonth[] {
  if (!MONTH_KEY_RE.test(monthKey)) {
    throw new Error(`Malformed month key: "${monthKey}"`);
  }
  const firstDayKey = `${monthKey}-01`;
  const lastDayKey = dayKeyOf(lastDayOfMonth(dayDate(firstDayKey)));
  const result: WeekInMonth[] = [];
  let weekKey = weekKeyForDay(firstDayKey);
  for (;;) {
    const days = weekDayKeys(weekKey);
    const dayKeysInMonth = days.filter((d) => monthKeyForDay(d) === monthKey);
    result.push({ weekKey, dayKeysInMonth });
    const sunday = days[6]!;
    if (sunday >= lastDayKey) break;
    weekKey = weekKeyForDay(dayKeyOf(addDays(dayDate(sunday), 1)));
  }
  return result;
}

/**
 * Every period whose summary input can change when this day's summary
 * changes: the day's ISO week, every month that week overlaps (a
 * boundary week feeds two month summaries), and those months' years.
 */
export function ancestorKeysForDay(dayKey: string): string[] {
  const weekKey = weekKeyForDay(dayKey);
  const monthKeys = monthKeysForWeek(weekKey);
  const yearKeys = [...new Set(monthKeys.map(yearKeyForMonth))];
  return [weekKey, ...monthKeys, ...yearKeys];
}

export function periodEndDayKey(key: string): string {
  const level = periodLevelOf(key);
  switch (level) {
    case "day":
      return key;
    case "week":
      return weekDayKeys(key)[6]!;
    case "month":
      return dayKeyOf(lastDayOfMonth(dayDate(`${key}-01`)));
    case "year":
      return `${key}-12-31`;
  }
}

/** A period is complete once its final day is strictly before today. */
export function isPeriodComplete(key: string, todayDayKey: string): boolean {
  return periodEndDayKey(key) < todayDayKey;
}

const LEVEL_ORDER: Record<PeriodLevel, number> = {
  day: 0,
  week: 1,
  month: 2,
  year: 3,
};

/** Bottom-up (day→week→month→year), oldest-first within each level. */
export function sortForProcessing(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const levelDiff =
      LEVEL_ORDER[periodLevelOf(a)] - LEVEL_ORDER[periodLevelOf(b)];
    if (levelDiff !== 0) return levelDiff;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
