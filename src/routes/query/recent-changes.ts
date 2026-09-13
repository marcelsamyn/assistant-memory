import { defineEventHandler } from "h3";
import { queryRecentChanges } from "~/lib/query/recent-changes";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  queryRecentChangesRequestSchema,
  queryRecentChangesResponseSchema,
} from "~/lib/schemas/query-recent-changes";

export default defineEventHandler(async (event) => {
  const params = queryRecentChangesRequestSchema.parse(await readBody(event));
  return queryRecentChangesResponseSchema.parse(
    await queryRecentChanges({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
