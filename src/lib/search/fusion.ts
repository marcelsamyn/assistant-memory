/**
 * Reciprocal Rank Fusion (RRF) — merges several independent rankings of the
 * same id space into one ranking without normalising heterogeneous scores.
 * Each id scores Σ 1/(k + rank) over the lists it appears in.
 *
 * Common aliases: rrf, rank fusion, hybrid search fusion, mergeRankings.
 */

/** Standard RRF constant; dampens the contribution of low ranks. */
export const RRF_K = 60;

export interface FusedResult {
  id: string;
  score: number;
}

/**
 * @param rankings Ordered id lists (index 0 = best). An id repeated within a
 *   single list contributes only its first (best) rank.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k: number = RRF_K,
): FusedResult[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, rank) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
