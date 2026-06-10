import { createError, defineEventHandler } from "h3";
import {
  getSourceRequestSchema,
  getSourceResponseSchema,
} from "~/lib/schemas/sources";
import { sourceService } from "~/lib/sources";
import { getSourceSummary } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, sourceId, includeContent } = getSourceRequestSchema.parse(
    await readBody(event),
  );
  const db = await useDatabase();
  const source = await getSourceSummary(db, userId, sourceId);
  if (!source) {
    throw createError({
      statusCode: 404,
      statusMessage: "Source not found",
    });
  }

  if (!includeContent) {
    return getSourceResponseSchema.parse({ source });
  }

  const [raw] = await sourceService.fetchRaw(userId, [sourceId]);
  const content =
    raw?.kind === "inline"
      ? {
          text: raw.content,
          format: source.type === "document" ? "markdown" : "text",
        }
      : null;

  return getSourceResponseSchema.parse({
    source: { ...source, content },
  });
});
