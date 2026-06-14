import { locateVerbatim } from "./verbatim";
import { describe, expect, it } from "vitest";

describe("locateVerbatim", () => {
  it("returns the exact source slice for an exact substring", () => {
    const content = "Let's ship the beta on Friday for sure.";
    expect(locateVerbatim(content, "ship the beta on Friday")).toBe(
      "ship the beta on Friday",
    );
  });

  it("is case-sensitive (never normalizes case)", () => {
    expect(locateVerbatim("Ship the beta", "ship the beta")).toBeNull();
  });

  it("tolerates whitespace drift and returns the ORIGINAL characters", () => {
    const content = "I will\n   ship it tomorrow";
    // model collapsed the newline+spaces to a single space:
    expect(locateVerbatim(content, "I will ship it")).toBe(
      "I will\n   ship it",
    );
  });

  it("collapses repeated whitespace inside the candidate too", () => {
    expect(locateVerbatim("a   b", "a b")).toBe("a   b");
  });

  it("returns null when the candidate is absent", () => {
    expect(locateVerbatim("nothing here", "launch the rocket")).toBeNull();
  });

  it("returns null for null / empty / whitespace-only candidates", () => {
    expect(locateVerbatim("anything", null)).toBeNull();
    expect(locateVerbatim("anything", "")).toBeNull();
    expect(locateVerbatim("anything", "   ")).toBeNull();
  });

  it("trims the candidate before searching", () => {
    expect(locateVerbatim("ship the beta", "  ship the beta  ")).toBe(
      "ship the beta",
    );
  });

  it("returns null for an over-long candidate (cap guards runaway spans)", () => {
    const content = "x".repeat(500);
    expect(locateVerbatim(content, "x".repeat(300))).toBeNull();
  });
});
