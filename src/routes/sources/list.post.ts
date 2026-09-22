import { defineEventHandler } from "h3";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  listSourcesRequestSchema,
  listSourcesResponseSchema,
} from "~/lib/schemas/sources";
import { listSourcesPage } from "~/lib/sources-read";
import { useDatabase } from "~/utils/db";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, type, limit, cursor } = parseRequestBody(
    listSourcesRequestSchema,
    await readBody(event),
  );
  const db = await useDatabase();
  const result = await listSourcesPage({
    db,
    userId,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    type,
    limit,
    cursor,
    accessScope,
  });
  return listSourcesResponseSchema.parse(result);
});
