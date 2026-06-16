import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, RRF_K } from "./fusion";

describe("reciprocalRankFusion", () => {
  it("sums 1/(k+rank) across rankings and sorts descending", () => {
    // id "a": rank 0 in list1, rank 1 in list2
    // id "b": rank 1 in list1, rank 0 in list2
    // both symmetric -> equal scores; tie broken by id ascending
    const fused = reciprocalRankFusion([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
    const expectedScore = 1 / (RRF_K + 0) + 1 / (RRF_K + 1);
    expect(fused[0]!.score).toBeCloseTo(expectedScore, 10);
  });

  it("ranks an id appearing high in both lists above a single-list id", () => {
    const fused = reciprocalRankFusion([
      ["x", "y", "z"],
      ["x", "w"],
    ]);
    expect(fused[0]!.id).toBe("x");
  });

  it("handles empty rankings", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("deduplicates ids within a single ranking by best (first) rank", () => {
    const fused = reciprocalRankFusion([["a", "a", "b"]]);
    const a = fused.find((f) => f.id === "a")!;
    expect(a.score).toBeCloseTo(1 / (RRF_K + 0), 10);
  });
});
