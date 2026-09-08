import { defineEventHandler } from "h3";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { queryChangeFeed } from "~/lib/query/change-feed";
import {
  queryChangeFeedRequestSchema,
  queryChangeFeedResponseSchema,
} from "~/lib/schemas/query-change-feed";

/** Replay-safe lifecycle feed for projection consumers. */
export default defineEventHandler(async (event) => {
  const request = queryChangeFeedRequestSchema.parse(await readBody(event));
  try {
    return queryChangeFeedResponseSchema.parse(await queryChangeFeed(request));
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
