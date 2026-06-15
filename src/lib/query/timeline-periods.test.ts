import { describe, expect, it } from "vitest";
import { periodKeysForWindow } from "./timeline-periods";

describe("periodKeysForWindow", () => {
  // June 1 2026 is a Monday (ISO 2026-W23); June 29 2026 is a Monday (2026-W27).
  it("includes the year, month, and ISO weeks containing days in the window", () => {
    const keys = periodKeysForWindow("2026-06-01", "2026-06-30");
    expect(keys).toContain("2026");
    expect(keys).toContain("2026-06");
    expect(keys).toContain("2026-W23");
    expect(keys).toContain("2026-W27");
  });

  it("excludes adjacent months and any day-format keys", () => {
    const keys = periodKeysForWindow("2026-06-01", "2026-06-30");
    expect(keys).not.toContain("2026-05");
    expect(keys).not.toContain("2026-07");
    expect(keys.every((k) => !/^\d{4}-\d{2}-\d{2}$/.test(k))).toBe(true);
  });

  it("handles a single-day window", () => {
    const keys = periodKeysForWindow("2026-06-10", "2026-06-10");
    expect(keys.sort()).toEqual(["2026", "2026-06", "2026-W24"].sort());
  });
});
