import { createError, defineEventHandler } from "h3";
import { getSourceIngestionOperation } from "~/lib/ingestion/source-processing";
import {
  getSourceRequestSchema,
  getSourceResponseSchema,
} from "~/lib/schemas/sources";
import { sourceContentFromRaw } from "~/lib/source-content";
import { sourceService } from "~/lib/sources";
import { getSourceSummary } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, sourceId, includeContent } =
    getSourceRequestSchema.parse(await readBody(event));
  const db = await useDatabase();
  const source = await getSourceSummary(db, userId, sourceId, partitionKey);
  if (!source) {
    throw createError({
      statusCode: 404,
      statusMessage: "Source not found",
    });
  }

  const processing = await getSourceIngestionOperation({
    db,
    userId,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    sourceId,
  });

  if (!includeContent) {
    return getSourceResponseSchema.parse({ source: { ...source, processing } });
  }

  const [raw] = await sourceService.fetchRaw(userId, [sourceId]);
  const content = sourceContentFromRaw(raw, source.type);

  return getSourceResponseSchema.parse({
    source: { ...source, content, processing },
  });
});
