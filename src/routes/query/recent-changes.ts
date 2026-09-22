import { defineEventHandler } from "h3";
import { queryRecentChanges } from "~/lib/query/recent-changes";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  queryRecentChangesRequestSchema,
  queryRecentChangesResponseSchema,
} from "~/lib/schemas/query-recent-changes";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    queryRecentChangesRequestSchema,
    await readBody(event),
  );
  return queryRecentChangesResponseSchema.parse(
    await queryRecentChanges({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
