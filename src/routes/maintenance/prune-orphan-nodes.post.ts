import { defineEventHandler, readBody } from "h3";
import { pruneOrphanNodes } from "~/lib/jobs/prune-orphan-nodes";
import { assertPartitionReadAllowed } from "~/lib/partition-access";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  pruneOrphanNodesRequestSchema,
  pruneOrphanNodesResponseSchema,
} from "~/lib/schemas/prune-orphan-nodes";
import { resolveWorkspacePartitions } from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = pruneOrphanNodesRequestSchema.parse(await readBody(event));
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
  let remainingNodeLimit = params.limit;
  let remainingSourceScanLimit = params.sourceScanLimit;
  for (const strictPartitionKey of partitions) {
    if (remainingNodeLimit === 0 || remainingSourceScanLimit === 0) break;
    const result = await pruneOrphanNodes(
      {
        ...params,
        limit: Math.min(params.limit, remainingNodeLimit),
        sourceScanLimit: Math.min(
          params.sourceScanLimit,
          remainingSourceScanLimit,
        ),
        ...(strictPartitionKey === undefined
          ? { partitionKey: undefined }
          : { partitionKey: strictPartitionKey }),
      },
      db,
    );
    results.push(result);
    remainingNodeLimit = Math.max(
      0,
      remainingNodeLimit -
        (params.dryRun ? result.candidateCount : result.deletedCount),
    );
    remainingSourceScanLimit -= result.sourceScanCount;
  }
  const first = results[0];
  if (!first) {
    return pruneOrphanNodesResponseSchema.parse({
      ...params,
      sourceScanCount: 0,
      sourceScanHasMore: false,
      missingBlobSourceCandidateCount: 0,
      deletedMissingBlobSourceCount: 0,
      candidateCount: 0,
      deletedCount: 0,
      hasMore: false,
      candidates: [],
      missingBlobSources: [],
      scannedNodeTypes: params.nodeTypes ?? [],
    });
  }
  const result = {
    ...first,
    sourceScanCount: results.reduce(
      (sum, item) => sum + item.sourceScanCount,
      0,
    ),
    sourceScanHasMore: results.some((item) => item.sourceScanHasMore),
    missingBlobSourceCandidateCount: results.reduce(
      (sum, item) => sum + item.missingBlobSourceCandidateCount,
      0,
    ),
    deletedMissingBlobSourceCount: results.reduce(
      (sum, item) => sum + item.deletedMissingBlobSourceCount,
      0,
    ),
    candidateCount: results.reduce((sum, item) => sum + item.candidateCount, 0),
    deletedCount: results.reduce((sum, item) => sum + item.deletedCount, 0),
    hasMore:
      results.some((item) => item.hasMore) ||
      results.length < partitions.length,
    candidates: results
      .flatMap((item) => item.candidates)
      .slice(0, params.sampleLimit),
    missingBlobSources: results
      .flatMap((item) => item.missingBlobSources)
      .slice(0, params.sampleLimit),
  };
  return pruneOrphanNodesResponseSchema.parse(result);
});
