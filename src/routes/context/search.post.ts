/**
 * `POST /context/search` — card-shaped search route.
 *
 * Coexists with the legacy `POST /query/search` (which keeps its raw
 * node/claim/connection shape for visualization). New consumers should target
 * this route. The `scope` parameter selects between `searchMemory` (personal)
 * and `searchReference`; the two scopes never mix in a single response so
 * reference material is never rendered as a personal fact.
 */
import { searchMemory, searchReference } from "~/lib/context/search-cards";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  contextSearchRequestSchema,
  contextSearchResponseSchema,
} from "~/lib/schemas/context-search";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  const { userId, partitionKey, query, limit, scope, excludeNodeTypes } =
    parseRequestBody(contextSearchRequestSchema, await readBody(event));

  const fn = scope === "reference" ? searchReference : searchMemory;
  const result = await fn({
    userId,
    accessScope,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    query,
    limit,
    excludeNodeTypes,
  });

  return contextSearchResponseSchema.parse(result);
});
