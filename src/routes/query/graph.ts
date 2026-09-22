import { defineEventHandler } from "h3";
import { queryKnowledgeGraph } from "~/lib/query/graph";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  queryGraphRequestSchema,
  queryGraphResponseSchema,
} from "~/lib/schemas/query-graph";

export default defineEventHandler(async (event) => {
  const params = parseRequestBody(
    queryGraphRequestSchema,
    await readBody(event),
  );
  const result = await queryKnowledgeGraph({
    ...params,
    accessScope: getRequestAccessScope(event),
  });
  return queryGraphResponseSchema.parse(result);
});
