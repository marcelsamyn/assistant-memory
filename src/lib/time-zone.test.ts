import { describe, expect, it } from "vitest";
import { instantFromLocalTime, startOfDayInTimeZone, isValidTimeZone } from "./time-zone";

describe("instantFromLocalTime", () => {
  it("resolves a winter (standard-offset) wall-clock time", () => {
    // America/New_York is UTC-5 (EST) in January.
    expect(instantFromLocalTime("2026-01-15", "09:00", "America/New_York").toISOString())
      .toBe("2026-01-15T14:00:00.000Z");
  });

  it("resolves a summer (DST-offset) wall-clock time", () => {
    // America/New_York is UTC-4 (EDT) in July.
    expect(instantFromLocalTime("2026-07-15", "09:00", "America/New_York").toISOString())
      .toBe("2026-07-15T13:00:00.000Z");
  });

  it("resolves a half-hour offset zone", () => {
    // Asia/Kolkata is UTC+5:30 year-round.
    expect(instantFromLocalTime("2026-03-01", "09:00", "Asia/Kolkata").toISOString())
      .toBe("2026-03-01T03:30:00.000Z");
  });

  it("round-trips: formatting the instant back in the zone reproduces the input", () => {
    const tz = "Europe/Paris";
    const instant = instantFromLocalTime("2026-06-10", "17:30", tz);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
      day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    expect(`${get("year")}-${get("month")}-${get("day")}`).toBe("2026-06-10");
    expect(`${get("hour")}:${get("minute")}`).toBe("17:30");
  });

  it("is deterministic on a spring-forward non-existent local time", () => {
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 02:00→03:00).
    const a = instantFromLocalTime("2026-03-08", "02:30", "America/New_York");
    const b = instantFromLocalTime("2026-03-08", "02:30", "America/New_York");
    expect(Number.isNaN(a.getTime())).toBe(false);
    expect(a.toISOString()).toBe(b.toISOString());
  });

  it("startOfDayInTimeZone equals instantFromLocalTime at 00:00", () => {
    expect(startOfDayInTimeZone("2026-07-15", "America/New_York").toISOString())
      .toBe(instantFromLocalTime("2026-07-15", "00:00", "America/New_York").toISOString());
  });
});

describe("isValidTimeZone", () => {
  it("validates IANA zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("startOfDayInTimeZone", () => {
  it("treats UTC midnight as itself", () => {
    expect(startOfDayInTimeZone("2026-05-29", "UTC").toISOString())
      .toBe("2026-05-29T00:00:00.000Z");
  });

  it("shifts a behind-UTC zone forward (EDT, UTC-4)", () => {
    expect(startOfDayInTimeZone("2026-05-29", "America/New_York").toISOString())
      .toBe("2026-05-29T04:00:00.000Z");
  });

  it("shifts an ahead-of-UTC zone back across the date line", () => {
    expect(startOfDayInTimeZone("2026-05-29", "Asia/Kolkata").toISOString())
      .toBe("2026-05-28T18:30:00.000Z");
  });
});
