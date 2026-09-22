import { getDeepResearchResult } from "~/lib/cache/deep-research-cache";
import { formatSearchResultsAsXml } from "~/lib/formatting";
import { searchMemory } from "~/lib/query/search";
import { getRequestAccessScope } from "~/lib/request-access";
import { parseRequestBody } from "~/lib/request-body";
import {
  querySearchRequestSchema,
  QuerySearchResponse,
  querySearchResponseSchema,
  searchResultsSchema,
} from "~/lib/schemas/query-search";

export default defineEventHandler(async (event) => {
  const accessScope = getRequestAccessScope(event);
  // Parse the request
  const {
    userId,
    partitionKey,
    query,
    limit,
    excludeNodeTypes,
    conversationId,
  } = parseRequestBody(querySearchRequestSchema, await readBody(event));

  // Get the standard search results
  const { searchResults } = await searchMemory({
    userId,
    accessScope,
    ...(partitionKey !== undefined ? { partitionKey } : {}),
    query,
    limit,
    excludeNodeTypes,
  });

  // If no conversationId is provided, just format and return standard results
  if (!conversationId) {
    return querySearchResponseSchema.parse({
      query,
      searchResults,
      formattedResult: formatSearchResultsAsXml(searchResults),
    });
  }

  // Try to get deep research results from cache
  const deepResults =
    accessScope === "workspace"
      ? null
      : await getDeepResearchResult(userId, conversationId, partitionKey);

  // If no deep research results, format and return standard results
  if (!deepResults) {
    return querySearchResponseSchema.parse({
      query,
      searchResults,
      formattedResult: formatSearchResultsAsXml(searchResults),
    });
  }

  // Combine standard and deep research results before formatting
  const combinedResults = [...searchResults, ...deepResults.results];

  // Validate combined results through the schema
  const validatedResults = searchResultsSchema.parse(combinedResults);

  // Format the validated results
  const formattedResult = formatSearchResultsAsXml(validatedResults);

  return querySearchResponseSchema.parse({
    query,
    searchResults: validatedResults,
    formattedResult,
  } satisfies QuerySearchResponse);
});
