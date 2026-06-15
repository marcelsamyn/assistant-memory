import { eachDayOfInterval } from "date-fns";
import {
  dayDate,
  dayKeyOf,
  monthKeyForDay,
  weekKeyForDay,
  yearKeyForMonth,
} from "../rollup/period";

/**
 * The distinct week/month/year period keys that contain at least one day in
 * [rangeMin, rangeMax] (both `YYYY-MM-DD`, rangeMin <= rangeMax). Membership is
 * defined by each day's own week/month/year, so a week straddling a month
 * boundary never drags in the adjacent month. Day-level keys are never returned.
 *
 * aka: timeline rollup period keys, week/month/year keys for a date window.
 */
export function periodKeysForWindow(
  rangeMin: string,
  rangeMax: string,
): string[] {
  const keys = new Set<string>();
  for (const day of eachDayOfInterval({
    start: dayDate(rangeMin),
    end: dayDate(rangeMax),
  })) {
    const dayKey = dayKeyOf(day);
    const monthKey = monthKeyForDay(dayKey);
    keys.add(weekKeyForDay(dayKey));
    keys.add(monthKey);
    keys.add(yearKeyForMonth(monthKey));
  }
  return [...keys];
}
