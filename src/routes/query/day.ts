import { defineEventHandler } from "h3";
import { queryDayMemories } from "~/lib/query/day";
import {
  queryDayRequestSchema,
  queryDayResponseSchema,
} from "~/lib/schemas/query-day";

// TODO Validate to make sure we have one-hop results
// eg., conversation is linked to the day node
//      and what's mentioned inside is one hop further

export default defineEventHandler(async (event) => {
  const { userId, partitionKey, date, includeFormattedResult } =
    queryDayRequestSchema.parse(await readBody(event));
  return queryDayResponseSchema.parse(
    await queryDayMemories({
      userId,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      date,
      includeFormattedResult,
    }),
  );
});
