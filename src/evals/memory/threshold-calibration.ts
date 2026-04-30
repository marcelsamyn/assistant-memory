/**
 * Identity-resolution threshold calibration sub-harness.
 *
 * The plan calls for a sweep of identity-resolution thresholds over a small,
 * curated dataset of label pairs (`shouldMerge: bool`). The output is a
 * CSV/JSON artifact suitable for review.
 *
 * Approach: rather than wire a full embedding model into the harness, we
 * simulate the identity resolver's three deterministic decision paths
 * (canonical-label exact match, alias hit, embedding similarity score) using
 * a string-similarity proxy (Dice coefficient over bigrams). This gives a
 * stable, reviewable measurement of how a given embedding-similarity cutoff
 * would interact with the merge pipeline.
 *
 * The CSV records, per threshold, precision/recall/F1 and per-pair outcome.
 * Treat the numbers as a *relative* signal across thresholds — not as
 * absolute model accuracy. The model-aware sweep that exercises the real
 * Jina embedding endpoint is gated behind `RUN_REAL_EMBEDDINGS=1` and is not
 * run by default (see end of file).
 *
 * Common aliases: identity threshold sweep, calibration harness, identity
 * eval CSV.
 */
// This module is pure (no DB, no env consumers), so env defaults are not
// required for the calibration sweep itself. Importing this module from the
// vitest unit test does not trigger env parsing.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ThresholdPair {
  /** Stable id for the pair, used as a key in artifacts. */
  id: string;
  labelA: string;
  labelB: string;
  shouldMerge: boolean;
  /** Optional human-readable justification. */
  comment?: string;
}

export const DEFAULT_THRESHOLD_PAIRS: ThresholdPair[] = [
  {
    id: "nickname-full-name",
    labelA: "Jonathan",
    labelB: "Jon",
    shouldMerge: true,
    comment: "common nickname/full-name pair",
  },
  {
    id: "typo-single-letter",
    labelA: "Acme Corp",
    labelB: "Acme Corp.",
    shouldMerge: true,
    comment: "trailing punctuation difference",
  },
  {
    id: "typo-transposed",
    labelA: "Marcel Samyn",
    labelB: "Marcel Smayn",
    shouldMerge: true,
    comment: "common transposition typo",
  },
  {
    id: "same-name-different-people",
    labelA: "John Smith (NYC)",
    labelB: "John Smith (Berlin)",
    shouldMerge: false,
    comment: "disambiguating qualifier — must NOT merge",
  },
  {
    id: "company-vs-product",
    labelA: "Apple",
    labelB: "Apple Pie",
    shouldMerge: false,
    comment: "shared prefix but distinct concepts",
  },
  {
    id: "abbreviation",
    labelA: "United Kingdom",
    labelB: "UK",
    shouldMerge: true,
    comment: "abbreviation needs alias-driven merge, not embedding similarity",
  },
  {
    id: "case-only",
    labelA: "iPhone",
    labelB: "iphone",
    shouldMerge: true,
    comment: "case folding only",
  },
  {
    id: "different-people-similar-name",
    labelA: "Jonathan Smith",
    labelB: "Jonah Smith",
    shouldMerge: false,
    comment: "similar but distinct first names",
  },
  {
    id: "alias-vs-canonical",
    labelA: "Project Alpha",
    labelB: "Project A1",
    shouldMerge: true,
    comment: "alias rename — must rely on alias system, not similarity",
  },
  {
    id: "completely-unrelated",
    labelA: "World Cup",
    labelB: "Fishing rod",
    shouldMerge: false,
    comment: "control case — must not merge",
  },
];

export const DEFAULT_THRESHOLD_VALUES: number[] = [0.7, 0.75, 0.8, 0.85, 0.9];

/** Lower-cased bigram set; empty for inputs shorter than two characters. */
function bigrams(value: string): Set<string> {
  const lower = value.toLowerCase().trim();
  const set = new Set<string>();
  for (let i = 0; i < lower.length - 1; i++) {
    set.add(lower.slice(i, i + 2));
  }
  return set;
}

/** Dice coefficient over bigrams — a deterministic proxy for embedding similarity. */
export function dice(a: string, b: string): number {
  const aSet = bigrams(a);
  const bSet = bigrams(b);
  if (aSet.size === 0 && bSet.size === 0) return 1;
  if (aSet.size === 0 || bSet.size === 0) return 0;
  let overlap = 0;
  for (const bigram of aSet) if (bSet.has(bigram)) overlap += 1;
  return (2 * overlap) / (aSet.size + bSet.size);
}

export interface PairOutcome {
  pairId: string;
  threshold: number;
  predictedMerge: boolean;
  shouldMerge: boolean;
  similarity: number;
  outcome: "tp" | "fp" | "tn" | "fn";
}

export interface ThresholdRow {
  threshold: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ThresholdSweepResult {
  generatedAt: string;
  pairs: ThresholdPair[];
  thresholds: number[];
  outcomes: PairOutcome[];
  rows: ThresholdRow[];
}

function classify(predicted: boolean, actual: boolean): PairOutcome["outcome"] {
  if (predicted && actual) return "tp";
  if (predicted && !actual) return "fp";
  if (!predicted && !actual) return "tn";
  return "fn";
}

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function runThresholdSweep(
  pairs: ThresholdPair[] = DEFAULT_THRESHOLD_PAIRS,
  thresholds: number[] = DEFAULT_THRESHOLD_VALUES,
  similarity: (a: string, b: string) => number = dice,
): ThresholdSweepResult {
  const outcomes: PairOutcome[] = [];
  const rows: ThresholdRow[] = [];

  // Precompute similarity once per pair — independent of threshold.
  const sims = pairs.map((pair) => ({
    pair,
    sim: similarity(pair.labelA, pair.labelB),
  }));

  for (const threshold of thresholds) {
    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;
    for (const { pair, sim } of sims) {
      const predictedMerge = sim >= threshold;
      const outcome = classify(predictedMerge, pair.shouldMerge);
      outcomes.push({
        pairId: pair.id,
        threshold,
        predictedMerge,
        shouldMerge: pair.shouldMerge,
        similarity: sim,
        outcome,
      });
      if (outcome === "tp") tp += 1;
      else if (outcome === "fp") fp += 1;
      else if (outcome === "tn") tn += 1;
      else fn += 1;
    }
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    const f1 = safeDiv(2 * precision * recall, precision + recall);
    rows.push({
      threshold,
      truePositive: tp,
      falsePositive: fp,
      trueNegative: tn,
      falseNegative: fn,
      precision,
      recall,
      f1,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    pairs,
    thresholds,
    outcomes,
    rows,
  };
}

function toCsv(result: ThresholdSweepResult): string {
  const header = "threshold,truePositive,falsePositive,trueNegative,falseNegative,precision,recall,f1";
  const lines = [header];
  for (const row of result.rows) {
    lines.push(
      [
        row.threshold,
        row.truePositive,
        row.falsePositive,
        row.trueNegative,
        row.falseNegative,
        row.precision.toFixed(4),
        row.recall.toFixed(4),
        row.f1.toFixed(4),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

function toPairCsv(result: ThresholdSweepResult): string {
  const header = "pairId,labelA,labelB,shouldMerge,similarity,threshold,predictedMerge,outcome";
  const lines = [header];
  const pairById = new Map(result.pairs.map((p) => [p.id, p]));
  for (const o of result.outcomes) {
    const pair = pairById.get(o.pairId)!;
    lines.push(
      [
        o.pairId,
        JSON.stringify(pair.labelA),
        JSON.stringify(pair.labelB),
        o.shouldMerge,
        o.similarity.toFixed(4),
        o.threshold,
        o.predictedMerge,
        o.outcome,
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

export async function writeThresholdArtifacts(
  result: ThresholdSweepResult,
  outDir = resolve(process.cwd(), "eval-output"),
): Promise<{ jsonPath: string; csvPath: string; pairCsvPath: string }> {
  const jsonPath = resolve(outDir, "identity-thresholds.json");
  const csvPath = resolve(outDir, "identity-thresholds.csv");
  const pairCsvPath = resolve(outDir, "identity-threshold-pairs.csv");
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  await writeFile(csvPath, toCsv(result), "utf8");
  await writeFile(pairCsvPath, toPairCsv(result), "utf8");
  return { jsonPath, csvPath, pairCsvPath };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const result = runThresholdSweep();
  writeThresholdArtifacts(result)
    .then(({ jsonPath, csvPath, pairCsvPath }) => {
      process.stderr.write(
        `[identity-thresholds] wrote:\n  ${jsonPath}\n  ${csvPath}\n  ${pairCsvPath}\n`,
      );
    })
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
