import { defineEventHandler } from "h3";
import { queryTimeline } from "~/lib/query/timeline";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  queryTimelineRequestSchema,
  queryTimelineResponseSchema,
} from "~/lib/schemas/query-timeline";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    queryTimelineRequestSchema,
    await readBody(event),
  );
  return queryTimelineResponseSchema.parse(
    await queryTimeline({
      ...params,
      accessScope: getRequestAccessScope(event),
    }),
  );
});
