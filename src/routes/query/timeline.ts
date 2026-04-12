import { defineEventHandler } from "h3";
import { queryTimeline } from "~/lib/query/timeline";
import {
  queryTimelineRequestSchema,
  queryTimelineResponseSchema,
} from "~/lib/schemas/query-timeline";

export default defineEventHandler(async (event) => {
  const params = queryTimelineRequestSchema.parse(await readBody(event));
  return queryTimelineResponseSchema.parse(await queryTimeline(params));
});
