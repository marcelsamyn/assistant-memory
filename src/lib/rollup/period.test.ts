import {
  ancestorKeysForDay,
  isPeriodComplete,
  monthKeyForDay,
  monthKeysForWeek,
  monthKeysOfYear,
  periodEndDayKey,
  periodLevelOf,
  sortForProcessing,
  weekDayKeys,
  weekKeyForDay,
  weeksOverlappingMonth,
  yearKeyForMonth,
} from "./period";
import { describe, expect, it } from "vitest";

describe("periodLevelOf", () => {
  it("classifies keys by shape", () => {
    expect(periodLevelOf("2026-06-08")).toBe("day");
    expect(periodLevelOf("2026-W24")).toBe("week");
    expect(periodLevelOf("2026-06")).toBe("month");
    expect(periodLevelOf("2026")).toBe("year");
  });

  it("throws on malformed keys", () => {
    expect(() => periodLevelOf("2026-6-8")).toThrow();
    expect(() => periodLevelOf("W24")).toThrow();
    expect(() => periodLevelOf("")).toThrow();
  });
});

describe("weekKeyForDay", () => {
  it("maps a mid-year Monday to its ISO week", () => {
    // 2026-06-08 is a Monday in ISO week 24 of 2026.
    expect(weekKeyForDay("2026-06-08")).toBe("2026-W24");
    expect(weekKeyForDay("2026-06-14")).toBe("2026-W24"); // its Sunday
  });

  it("assigns early-January days to the correct ISO week-numbering year", () => {
    // 2026 W01 spans 2025-12-29 .. 2026-01-04.
    expect(weekKeyForDay("2025-12-29")).toBe("2026-W01");
    expect(weekKeyForDay("2026-01-01")).toBe("2026-W01");
    // 2026 has 53 ISO weeks; W53 spans 2026-12-28 .. 2027-01-03.
    expect(weekKeyForDay("2027-01-01")).toBe("2026-W53");
  });
});

describe("weekDayKeys", () => {
  it("returns Monday..Sunday day keys", () => {
    expect(weekDayKeys("2026-W24")).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
      "2026-06-13",
      "2026-06-14",
    ]);
  });

  it("handles a year-straddling week", () => {
    expect(weekDayKeys("2026-W53")[0]).toBe("2026-12-28");
    expect(weekDayKeys("2026-W53")[6]).toBe("2027-01-03");
  });
});

describe("month/year containment", () => {
  it("maps days and months upward by prefix", () => {
    expect(monthKeyForDay("2026-06-08")).toBe("2026-06");
    expect(yearKeyForMonth("2026-06")).toBe("2026");
    expect(monthKeysOfYear("2026")).toHaveLength(12);
    expect(monthKeysOfYear("2026")[0]).toBe("2026-01");
    expect(monthKeysOfYear("2026")[11]).toBe("2026-12");
  });

  it("finds the month(s) a week overlaps", () => {
    expect(monthKeysForWeek("2026-W24")).toEqual(["2026-06"]);
    // W53 2026 straddles December 2026 and January 2027.
    expect(monthKeysForWeek("2026-W53")).toEqual(["2026-12", "2027-01"]);
  });
});

describe("weeksOverlappingMonth", () => {
  it("lists every overlapping ISO week with its in-month days", () => {
    // June 2026: Jun 1 is a Monday (W23); Jun 29-30 fall in W27.
    const weeks = weeksOverlappingMonth("2026-06");
    expect(weeks.map((w) => w.weekKey)).toEqual([
      "2026-W23",
      "2026-W24",
      "2026-W25",
      "2026-W26",
      "2026-W27",
    ]);
    const last = weeks[4]!;
    expect(last.dayKeysInMonth).toEqual(["2026-06-29", "2026-06-30"]);
    const first = weeks[0]!;
    expect(first.dayKeysInMonth).toHaveLength(7);
  });
});

describe("ancestorKeysForDay", () => {
  it("returns week, overlapping months, and their years", () => {
    expect(ancestorKeysForDay("2026-06-08")).toEqual([
      "2026-W24",
      "2026-06",
      "2026",
    ]);
  });

  it("includes both straddled months and years at a boundary", () => {
    expect(ancestorKeysForDay("2027-01-01")).toEqual([
      "2026-W53",
      "2026-12",
      "2027-01",
      "2026",
      "2027",
    ]);
  });
});

describe("periodEndDayKey / isPeriodComplete", () => {
  it("computes the period's final day", () => {
    expect(periodEndDayKey("2026-06-08")).toBe("2026-06-08");
    expect(periodEndDayKey("2026-W24")).toBe("2026-06-14");
    expect(periodEndDayKey("2026-06")).toBe("2026-06-30");
    expect(periodEndDayKey("2026-02")).toBe("2026-02-28");
    expect(periodEndDayKey("2026")).toBe("2026-12-31");
  });

  it("a period is complete only when its last day is strictly before today", () => {
    expect(isPeriodComplete("2026-W24", "2026-06-14")).toBe(false);
    expect(isPeriodComplete("2026-W24", "2026-06-15")).toBe(true);
    expect(isPeriodComplete("2026-06-14", "2026-06-15")).toBe(true);
    expect(isPeriodComplete("2026", "2026-12-31")).toBe(false);
    expect(isPeriodComplete("2026", "2027-01-01")).toBe(true);
  });
});

describe("sortForProcessing", () => {
  it("orders bottom-up by level, then oldest-first within a level", () => {
    expect(
      sortForProcessing([
        "2026",
        "2026-06",
        "2026-W24",
        "2026-06-09",
        "2026-06-08",
        "2026-W23",
      ]),
    ).toEqual([
      "2026-06-08",
      "2026-06-09",
      "2026-W23",
      "2026-W24",
      "2026-06",
      "2026",
    ]);
  });
});
