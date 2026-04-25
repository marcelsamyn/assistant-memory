import { fetchEntryNodes, cleanupGraphIteration } from "./cleanup-graph";
import type {
  CleanupGraphParams,
  CleanupGraphIterationParams,
  CleanupGraphResult,
} from "./cleanup-graph";
import { TypeId } from "~/types/typeid";

/**
 * Params for iterative cleanup across multiple seed batches
 */
export interface IterativeCleanupParams extends CleanupGraphParams {
  /**
   * Number of iterations to run (default: 3)
   */
  iterations?: number;
  /**
   * Number of seeds per iteration (default: entryNodeLimit)
   */
  seedsPerIteration?: number;
  /**
   * Whether to harvest new seeds from prior results (default: true)
   */
  dynamicFollowups?: boolean;
}

function pickNextSeeds(
  pool: TypeId<"node">[],
  processed: Set<TypeId<"node">>,
  count: number,
): TypeId<"node">[] {
  const next: TypeId<"node">[] = [];
  for (const id of pool) {
    if (!processed.has(id)) {
      next.push(id);
      if (next.length >= count) break;
    }
  }
  return next;
}

function harvestNewSeeds(result: CleanupGraphResult): TypeId<"node">[] {
  const keepIds = result.merged.map((m) => m.keep);
  const otherIds = Array.from(
    new Set<TypeId<"node">>([
      ...result.createdNodes.map((n) => n.nodeId),
      ...result.addedClaims.flatMap((claim) => [claim.subject, claim.object]),
    ]),
  );
  return [...keepIds, ...otherIds];
}

/**
 * Run multiple cleanup iterations with different seed sets
 */
export async function runIterativeCleanup(
  params: IterativeCleanupParams,
): Promise<void> {
  const {
    userId,
    since,
    entryNodeLimit,
    iterations = 3,
    seedsPerIteration = entryNodeLimit,
    dynamicFollowups = true,
  } = params;

  let seedPool = await fetchEntryNodes(
    userId,
    since,
    seedsPerIteration * iterations,
  );
  const processed = new Set<TypeId<"node">>();
  let successCount = 0;
  let attempt = 0;

  while (successCount < iterations) {
    attempt++;
    const seeds = pickNextSeeds(seedPool, processed, seedsPerIteration);
    console.debug(
      `[cleanup-iter] Attempt ${attempt} seeds: ${seeds.join(", ")}`,
    );
    if (seeds.length === 0) {
      console.debug(`[cleanup-iter] No seeds left; stopping early`);
      break;
    }

    const iterationParams: CleanupGraphIterationParams = {
      ...params,
      seedIds: seeds,
    };
    const result = await cleanupGraphIteration(iterationParams);

    // if subgraph too small, result is null -> skip counting success but mark processed
    if (!result) {
      seeds.forEach((id) => processed.add(id));
      continue;
    }

    successCount++;
    console.debug(
      `[cleanup-iter] Successful iteration ${successCount}: merges=${
        result.merged.length
      }, adds=${result.addedClaims.length}, creates=${result.createdNodes.length}`,
    );

    // mark seeds as processed
    seeds.forEach((id) => processed.add(id));

    // harvest follow-ups
    if (dynamicFollowups) {
      const newSeeds = harvestNewSeeds(result);
      seedPool = seedPool.concat(newSeeds);
      console.debug(
        `[cleanup-iter] Harvested ${newSeeds.length} follow-up seeds`,
      );
    }
  }

  console.info(
    `[cleanup-iter] Completed cleanup after ${successCount} successful iterations, processed ${processed.size} seeds`,
  );
}
