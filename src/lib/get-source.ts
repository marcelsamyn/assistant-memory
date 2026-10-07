import { createError } from "h3";
import { getSourceIngestionOperation } from "~/lib/ingestion/source-processing";
import type { MemoryAccessScope } from "~/lib/schemas/partition";
import {
  type GetSourceRequest,
  type GetSourceResponse,
  getSourceResponseSchema,
} from "~/lib/schemas/sources";
import { sourceContentFromRaw } from "~/lib/source-content";
import { loadSourceConversation } from "~/lib/source-conversation";
import { sourceService } from "~/lib/sources";
import { getSourceSummary } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export async function getSource({
  userId,
  partitionKey,
  sourceId,
  includeContent,
  accessScope = "partition",
}: GetSourceRequest & {
  accessScope?: MemoryAccessScope;
}): Promise<GetSourceResponse> {
  const db = await useDatabase();
  const source = await getSourceSummary(
    db,
    userId,
    sourceId,
    partitionKey,
    accessScope,
  );
  if (!source) {
    throw createError({
      statusCode: 404,
      statusMessage: "Source not found",
    });
  }

  const processing = await getSourceIngestionOperation({
    db,
    userId,
    ...(source.partitionKey !== null
      ? { partitionKey: source.partitionKey }
      : {}),
    sourceId,
    accessScope,
  });

  if (!includeContent) {
    return getSourceResponseSchema.parse({ source: { ...source, processing } });
  }

  const [[raw], conversation] = await Promise.all([
    sourceService.fetchRaw(userId, [sourceId]),
    loadSourceConversation(db, userId, source),
  ]);
  const content = sourceContentFromRaw(raw, source.type);

  return getSourceResponseSchema.parse({
    source: { ...source, content, conversation, processing },
  });
}
