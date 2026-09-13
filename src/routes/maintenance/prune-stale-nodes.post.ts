import { defineEventHandler, readBody } from "h3";
import { pruneStaleNodes } from "~/lib/jobs/prune-stale-nodes";
import { assertPartitionReadAllowed } from "~/lib/partition-access";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  pruneStaleNodesRequestSchema,
  pruneStaleNodesResponseSchema,
} from "~/lib/schemas/prune-stale-nodes";
import { resolveWorkspacePartitions } from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = pruneStaleNodesRequestSchema.parse(await readBody(event));
  const db = await useDatabase();
  const accessScope = getRequestAccessScope(event);
  const partitions = await resolveWorkspacePartitions(
    db,
    params.userId,
    params.partitionKey,
    accessScope,
  );
  if (accessScope === "workspace" && !params.dryRun) {
    await Promise.all(
      partitions.map((strictPartitionKey) =>
        assertPartitionReadAllowed(db, params.userId, strictPartitionKey),
      ),
    );
  }
  const results = [];
  let remainingLimit = params.limit;
  for (const strictPartitionKey of partitions) {
    if (remainingLimit === 0) break;
    const result = await pruneStaleNodes(
      {
        ...params,
        limit: Math.min(params.limit, remainingLimit),
        ...(strictPartitionKey === undefined
          ? { partitionKey: undefined }
          : { partitionKey: strictPartitionKey }),
      },
      db,
    );
    results.push(result);
    remainingLimit = Math.max(
      0,
      remainingLimit -
        (params.dryRun ? result.candidateCount : result.deletedCount),
    );
  }
  const first = results[0];
  if (!first) {
    return pruneStaleNodesResponseSchema.parse({
      ...params,
      scannedCount: 0,
      candidateCount: 0,
      deletedCount: 0,
      hasMore: false,
      candidates: [],
      scannedNodeTypes: params.nodeTypes ?? [],
      appliedThreshold: params.minScore ?? 1 - params.aggressiveness,
    });
  }
  const result = {
    ...first,
    scannedCount: results.reduce((sum, item) => sum + item.scannedCount, 0),
    candidateCount: results.reduce((sum, item) => sum + item.candidateCount, 0),
    deletedCount: results.reduce((sum, item) => sum + item.deletedCount, 0),
    hasMore:
      results.some((item) => item.hasMore) ||
      results.length < partitions.length,
    candidates: results
      .flatMap((item) => item.candidates)
      .slice(0, params.sampleLimit),
  };
  return pruneStaleNodesResponseSchema.parse(result);
});
