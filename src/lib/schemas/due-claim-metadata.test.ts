import { describe, expect, it } from "vitest";
import { dueClaimMetadataSchema, DUE_TIME_PATTERN } from "./due-claim-metadata";

describe("dueClaimMetadataSchema", () => {
  it("accepts a valid HH:mm + IANA zone", () => {
    const parsed = dueClaimMetadataSchema.parse({ dueTime: "17:00", timeZone: "America/New_York" });
    expect(parsed).toEqual({ dueTime: "17:00", timeZone: "America/New_York" });
  });

  it("rejects a bad time", () => {
    expect(dueClaimMetadataSchema.safeParse({ dueTime: "25:00", timeZone: "UTC" }).success).toBe(false);
    expect(dueClaimMetadataSchema.safeParse({ dueTime: "9:5", timeZone: "UTC" }).success).toBe(false);
  });

  it("rejects a bad zone", () => {
    expect(dueClaimMetadataSchema.safeParse({ dueTime: "09:00", timeZone: "Not/AZone" }).success).toBe(false);
  });

  it("DUE_TIME_PATTERN matches 24h HH:mm only", () => {
    expect(DUE_TIME_PATTERN.test("00:00")).toBe(true);
    expect(DUE_TIME_PATTERN.test("23:59")).toBe(true);
    expect(DUE_TIME_PATTERN.test("24:00")).toBe(false);
    expect(DUE_TIME_PATTERN.test("9:00")).toBe(false); // single-digit hour
    expect(DUE_TIME_PATTERN.test("00:60")).toBe(false); // invalid minute
  });
});
