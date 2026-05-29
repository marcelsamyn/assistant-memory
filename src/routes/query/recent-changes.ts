import { defineEventHandler } from "h3";
import { queryRecentChanges } from "~/lib/query/recent-changes";
import {
  queryRecentChangesRequestSchema,
  queryRecentChangesResponseSchema,
} from "~/lib/schemas/query-recent-changes";

export default defineEventHandler(async (event) => {
  const params = queryRecentChangesRequestSchema.parse(await readBody(event));
  return queryRecentChangesResponseSchema.parse(
    await queryRecentChanges(params),
  );
});
