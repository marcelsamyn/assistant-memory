import { createError, defineEventHandler } from "h3";
import {
  getSourceRequestSchema,
  getSourceResponseSchema,
} from "~/lib/schemas/sources";
import { getSourceSummary } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const { userId, sourceId } = getSourceRequestSchema.parse(
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
  return getSourceResponseSchema.parse({ source });
});
