import { defineEventHandler, readBody } from "h3";
import { PartitionedCleanupGraphUnsupportedError } from "~/lib/jobs/cleanup-graph";
import {
  cleanupPlaceholders,
  seedClaimsCleanupForPlaceholders,
} from "~/lib/jobs/cleanup-placeholders";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  cleanupPlaceholdersRequestSchema,
  cleanupPlaceholdersResponseSchema,
} from "~/lib/schemas/cleanup-placeholders";
import { resolveWorkspacePartitions } from "~/lib/workspace-partitions";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    cleanupPlaceholdersRequestSchema,
    await readBody(event),
  );
  const accessScope = getRequestAccessScope(event);
  if (accessScope === "workspace" && params.triggerCleanup) {
    throw new PartitionedCleanupGraphUnsupportedError();
  }
  const db = await useDatabase();
  const partitions = await resolveWorkspacePartitions(
    db,
    params.userId,
    params.partitionKey,
    accessScope,
  );
  const surfaced = [];
  let remainingLimit = params.limit;
  for (const strictPartitionKey of partitions) {
    if (remainingLimit === 0) break;
    const result = await cleanupPlaceholders({
      ...params,
      limit: Math.min(params.limit, remainingLimit),
      ...(strictPartitionKey === undefined
        ? { partitionKey: undefined }
        : { partitionKey: strictPartitionKey }),
    });
    surfaced.push(...result.placeholders);
    remainingLimit -= result.placeholders.length;
  }
  const result = { placeholders: surfaced.slice(0, params.limit) };

  const candidatesFound = result.placeholders.reduce(
    (acc, row) => acc + row.candidates.length,
    0,
  );

  let seededCleanupJob = false;
  let jobId: string | undefined;
  if (params.triggerCleanup) {
    const seeded = await seedClaimsCleanupForPlaceholders(params, result);
    if (seeded) {
      seededCleanupJob = true;
      jobId = seeded.jobId;
    }
  }

  return cleanupPlaceholdersResponseSchema.parse({
    placeholderCount: result.placeholders.length,
    candidatesFound,
    placeholders: result.placeholders,
    seededCleanupJob,
    jobId,
  });
});
