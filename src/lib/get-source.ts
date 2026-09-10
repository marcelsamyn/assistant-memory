import { createError } from "h3";
import { getSourceIngestionOperation } from "~/lib/ingestion/source-processing";
import {
  type GetSourceRequest,
  type GetSourceResponse,
  getSourceResponseSchema,
} from "~/lib/schemas/sources";
import { sourceContentFromRaw } from "~/lib/source-content";
import { sourceService } from "~/lib/sources";
import { getSourceSummary } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export async function getSource({
  userId,
  partitionKey,
  sourceId,
  includeContent,
}: GetSourceRequest): Promise<GetSourceResponse> {
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
}
