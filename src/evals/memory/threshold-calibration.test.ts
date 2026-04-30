/**
 * Unit tests for the deterministic identity-threshold sweep harness.
 *
 * These run in normal `pnpm run test` because they're pure functions — no DB,
 * no network. The DB-backed memory eval suite (`run-all.test.ts`) gates on a
 * reachable Postgres and is skipped otherwise.
 */
import {
  DEFAULT_THRESHOLD_PAIRS,
  DEFAULT_THRESHOLD_VALUES,
  dice,
  runThresholdSweep,
} from "./threshold-calibration";
import { describe, expect, it } from "vitest";

describe("threshold-calibration", () => {
  it("dice is symmetric and yields 1 for equal input", () => {
    expect(dice("acme", "acme")).toBe(1);
    expect(dice("foo", "bar")).toBe(dice("bar", "foo"));
  });

  it("returns one row per threshold and N*pairs outcomes", () => {
    const result = runThresholdSweep();
    expect(result.rows).toHaveLength(DEFAULT_THRESHOLD_VALUES.length);
    expect(result.outcomes).toHaveLength(
      DEFAULT_THRESHOLD_VALUES.length * DEFAULT_THRESHOLD_PAIRS.length,
    );
  });

  it("precision/recall/f1 are bounded in [0, 1]", () => {
    const result = runThresholdSweep();
    for (const row of result.rows) {
      expect(row.precision).toBeGreaterThanOrEqual(0);
      expect(row.precision).toBeLessThanOrEqual(1);
      expect(row.recall).toBeGreaterThanOrEqual(0);
      expect(row.recall).toBeLessThanOrEqual(1);
      expect(row.f1).toBeGreaterThanOrEqual(0);
      expect(row.f1).toBeLessThanOrEqual(1);
    }
  });

  it("higher thresholds never yield more true positives than a lower one", () => {
    const result = runThresholdSweep();
    for (let i = 1; i < result.rows.length; i++) {
      expect(result.rows[i]!.truePositive).toBeLessThanOrEqual(
        result.rows[i - 1]!.truePositive,
      );
    }
  });
});
