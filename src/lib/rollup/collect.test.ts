import {
  DAY_ENTRY_MAX_CHARS,
  DAY_INPUT_MAX_CHARS,
  buildDayInputText,
  buildMonthInputText,
  buildWeekInputText,
  buildYearInputText,
  fingerprintOf,
  readRollupMeta,
} from "./collect";
import { describe, expect, it } from "vitest";

describe("fingerprintOf", () => {
  it("is a stable sha256 hex of the input", () => {
    expect(fingerprintOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(fingerprintOf("abc")).toBe(fingerprintOf("abc"));
    expect(fingerprintOf("abc")).not.toBe(fingerprintOf("abd"));
  });
});

describe("readRollupMeta", () => {
  it("reads a valid rollup marker", () => {
    expect(
      readRollupMeta({ rollup: { fingerprint: "f1", summarizedAt: "t1" } }),
    ).toEqual({ fingerprint: "f1", summarizedAt: "t1" });
  });

  it("returns null for anything else", () => {
    expect(readRollupMeta(null)).toBeNull();
    expect(readRollupMeta(undefined)).toBeNull();
    expect(readRollupMeta({})).toBeNull();
    expect(readRollupMeta({ rollup: { fingerprint: 42 } })).toBeNull();
    expect(readRollupMeta([])).toBeNull();
    expect(readRollupMeta("rollup")).toBeNull();
  });
});

describe("buildDayInputText", () => {
  const entry = (label: string, description: string | null) => ({
    nodeType: "Conversation",
    label,
    description,
    createdAt: new Date("2026-06-08T10:00:00Z"),
  });

  it("returns null when there are no usable entries", () => {
    expect(buildDayInputText("2026-06-08", [])).toBeNull();
    expect(
      buildDayInputText("2026-06-08", [
        {
          nodeType: "Event",
          label: null,
          description: null,
          createdAt: new Date(0),
        },
      ]),
    ).toBeNull();
  });

  it("renders one capped line per entry, chronologically", () => {
    const text = buildDayInputText("2026-06-08", [
      entry("Standup", "Discussed the rollout plan with Sam."),
      entry("Gym session", null),
    ]);
    expect(text).toContain("Day: 2026-06-08");
    expect(text).toContain(
      "- [Conversation] Standup: Discussed the rollout plan with Sam.",
    );
    expect(text).toContain("- [Conversation] Gym session");
  });

  it("truncates an oversize entry to the per-entry cap", () => {
    const text = buildDayInputText("2026-06-08", [
      entry("Long", "x".repeat(DAY_ENTRY_MAX_CHARS * 2)),
    ]);
    const line = text!.split("\n").find((l) => l.startsWith("- "));
    expect(line!.length).toBeLessThanOrEqual(DAY_ENTRY_MAX_CHARS);
  });

  it("drops oldest entries beyond the total cap and says so", () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      nodeType: "Document",
      label: `Doc ${String(i).padStart(3, "0")}`,
      description: "y".repeat(500),
      createdAt: new Date(2026, 5, 8, 0, i),
    }));
    const text = buildDayInputText("2026-06-08", entries);
    expect(text!.length).toBeLessThanOrEqual(DAY_INPUT_MAX_CHARS + 200);
    expect(text).toContain("older entries omitted");
    // newest entry survives, oldest is dropped
    expect(text).toContain("Doc 099");
    expect(text).not.toContain("Doc 000");
  });
});

describe("buildWeekInputText", () => {
  it("returns null when no day has a summary", () => {
    expect(
      buildWeekInputText("2026-W24", [
        { key: "2026-06-08", summary: null },
        { key: "2026-06-09", summary: null },
      ]),
    ).toBeNull();
  });

  it("lists each day with its summary or a no-activity marker", () => {
    const text = buildWeekInputText("2026-W24", [
      { key: "2026-06-08", summary: "Shipped the rollup spec." },
      { key: "2026-06-09", summary: null },
    ]);
    expect(text).toContain("Week: 2026-W24");
    expect(text).toContain("2026-06-08: Shipped the rollup spec.");
    expect(text).toContain("2026-06-09: (no summarized activity)");
  });
});

describe("buildMonthInputText", () => {
  it("annotates boundary weeks with their in-month days", () => {
    const text = buildMonthInputText("2026-06", [
      {
        weekKey: "2026-W23",
        summary: "Full week in June.",
        dayKeysInMonth: [
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
          "2026-06-06",
          "2026-06-07",
        ],
      },
      {
        weekKey: "2026-W27",
        summary: "Straddles into July.",
        dayKeysInMonth: ["2026-06-29", "2026-06-30"],
      },
    ]);
    expect(text).toContain("Month: 2026-06");
    expect(text).toContain("2026-W23: Full week in June.");
    expect(text).toContain(
      "2026-W27 (only 2026-06-29 to 2026-06-30 fall in this month): Straddles into July.",
    );
  });

  it("returns null when no week has a summary", () => {
    expect(
      buildMonthInputText("2026-06", [
        { weekKey: "2026-W23", summary: null, dayKeysInMonth: [] },
      ]),
    ).toBeNull();
  });
});

describe("buildYearInputText", () => {
  it("lists months with summaries or markers, null when empty", () => {
    expect(
      buildYearInputText("2026", [{ key: "2026-01", summary: null }]),
    ).toBeNull();
    const text = buildYearInputText("2026", [
      { key: "2026-01", summary: "January arc." },
      { key: "2026-02", summary: null },
    ]);
    expect(text).toContain("Year: 2026");
    expect(text).toContain("2026-01: January arc.");
    expect(text).toContain("2026-02: (no summarized activity)");
  });
});
