import { defineEventHandler, readBody } from "h3";
import {
  cleanupPlaceholders,
  seedClaimsCleanupForPlaceholders,
} from "~/lib/jobs/cleanup-placeholders";
import {
  cleanupPlaceholdersRequestSchema,
  cleanupPlaceholdersResponseSchema,
} from "~/lib/schemas/cleanup-placeholders";

export default defineEventHandler(async (event) => {
  const params = cleanupPlaceholdersRequestSchema.parse(await readBody(event));

  const result = await cleanupPlaceholders({
    userId: params.userId,
    olderThanDays: params.olderThanDays,
    limit: params.limit,
  });

  const candidatesFound = result.placeholders.reduce(
    (acc, row) => acc + row.candidates.length,
    0,
  );

  let seededCleanupJob = false;
  let jobId: string | undefined;
  if (params.triggerCleanup) {
    const seeded = await seedClaimsCleanupForPlaceholders(
      {
        userId: params.userId,
        olderThanDays: params.olderThanDays,
        limit: params.limit,
      },
      result,
    );
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
