import { normalizeLabel } from "./label";
import { describe, it, expect } from "vitest";

describe("normalizeLabel", () => {
  it("lowercases and trims", () => {
    expect(normalizeLabel("  Marcel Samyn  ")).toBe("marcel samyn");
  });

  it("collapses multiple spaces", () => {
    expect(normalizeLabel("John    Doe")).toBe("john doe");
  });

  it("handles empty string", () => {
    expect(normalizeLabel("")).toBe("");
  });

  it("handles single word", () => {
    expect(normalizeLabel("Alice")).toBe("alice");
  });

  it("preserves non-ASCII characters", () => {
    expect(normalizeLabel("  José García  ")).toBe("josé garcía");
  });

  it("handles tabs and newlines", () => {
    expect(normalizeLabel("hello\t\nworld")).toBe("hello world");
  });
});
