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
import {
  contextSearchRequestSchema,
  contextSearchResponseSchema,
} from "~/lib/schemas/context-search";

export default defineEventHandler(async (event) => {
  const { userId, query, limit, scope, excludeNodeTypes } =
    contextSearchRequestSchema.parse(await readBody(event));

  const fn = scope === "reference" ? searchReference : searchMemory;
  const result = await fn({ userId, query, limit, excludeNodeTypes });

  return contextSearchResponseSchema.parse(result);
});
