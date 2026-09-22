import { defineEventHandler } from "h3";
import { queryDayMemories } from "~/lib/query/day";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  queryDayRequestSchema,
  queryDayResponseSchema,
} from "~/lib/schemas/query-day";

// TODO Validate to make sure we have one-hop results
// eg., conversation is linked to the day node
//      and what's mentioned inside is one hop further

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, date, includeFormattedResult } =
    parseRequestBody(queryDayRequestSchema, await readBody(event));
  return queryDayResponseSchema.parse(
    await queryDayMemories({
      userId,
      accessScope,
      ...(partitionKey !== undefined ? { partitionKey } : {}),
      date,
      includeFormattedResult,
    }),
  );
});
