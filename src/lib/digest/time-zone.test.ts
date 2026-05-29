import { isValidTimeZone, startOfDayInTimeZone } from "./time-zone";
import { describe, expect, it } from "vitest";

describe("isValidTimeZone", () => {
  it("accepts real IANA zones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Asia/Kolkata")).toBe(true);
  });

  it("rejects garbage and empty input", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("startOfDayInTimeZone", () => {
  it("treats UTC midnight as itself", () => {
    expect(startOfDayInTimeZone("2026-05-29", "UTC").toISOString()).toBe(
      "2026-05-29T00:00:00.000Z",
    );
  });

  it("shifts a behind-UTC zone forward (EDT, UTC-4)", () => {
    expect(
      startOfDayInTimeZone("2026-05-29", "America/New_York").toISOString(),
    ).toBe("2026-05-29T04:00:00.000Z");
  });

  it("shifts an ahead-of-UTC zone back across the date line", () => {
    expect(
      startOfDayInTimeZone("2026-05-29", "Asia/Kolkata").toISOString(),
    ).toBe("2026-05-28T18:30:00.000Z");
  });
});
