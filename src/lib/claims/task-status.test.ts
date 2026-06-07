import { coerceTaskStatus } from "./task-status";
import { describe, expect, it } from "vitest";

describe("coerceTaskStatus", () => {
  it("passes canonical values through unchanged", () => {
    expect(coerceTaskStatus("pending")).toBe("pending");
    expect(coerceTaskStatus("in_progress")).toBe("in_progress");
    expect(coerceTaskStatus("done")).toBe("done");
    expect(coerceTaskStatus("abandoned")).toBe("abandoned");
  });

  it("normalizes casing and spacing/hyphen variants", () => {
    expect(coerceTaskStatus("Done")).toBe("done");
    expect(coerceTaskStatus("In Progress")).toBe("in_progress");
    expect(coerceTaskStatus("in-progress")).toBe("in_progress");
    expect(coerceTaskStatus("  PENDING  ")).toBe("pending");
  });

  it("maps known off-vocabulary synonyms onto the canonical enum", () => {
    expect(coerceTaskStatus("completed")).toBe("done");
    expect(coerceTaskStatus("complete")).toBe("done");
    expect(coerceTaskStatus("cancelled")).toBe("abandoned");
    expect(coerceTaskStatus("canceled")).toBe("abandoned");
    expect(coerceTaskStatus("failed")).toBe("abandoned");
    expect(coerceTaskStatus("Failed")).toBe("abandoned");
    expect(coerceTaskStatus("todo")).toBe("pending");
    expect(coerceTaskStatus("doing")).toBe("in_progress");
  });

  it("returns null for values it can't confidently map", () => {
    expect(coerceTaskStatus("blocked")).toBeNull();
    expect(coerceTaskStatus("")).toBeNull();
    expect(coerceTaskStatus("   ")).toBeNull();
    expect(coerceTaskStatus(null)).toBeNull();
    expect(coerceTaskStatus(undefined)).toBeNull();
  });
});
