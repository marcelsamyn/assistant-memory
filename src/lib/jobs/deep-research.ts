import { performStructuredAnalysis } from "../ai";
import { storeDeepResearchResult } from "../cache/deep-research-cache";
import { generateEmbeddings } from "../embeddings";
import {
  escapeXml,
  formatSearchResultsWithIds,
  type SearchResultWithId,
  type SearchResults,
} from "../formatting";
import {
  findOneHopNodes,
  findSimilarClaims,
  findSimilarNodes,
  type NodeSearchResult,
  type ClaimSearchResult,
  type OneHopNode,
} from "../graph";
import { type RerankResult } from "../rerank";
import {
  DeepResearchJobInput,
  DeepResearchResult,
} from "../schemas/deep-research";
import { TemporaryIdMapper } from "../temporary-id-mapper";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { useDatabase } from "~/utils/db";
import { shuffleArray } from "~/utils/shuffle";

// Group definitions for reranked search results
type SearchGroups = {
  similarNodes: NodeSearchResult;
  similarClaims: ClaimSearchResult;
  connections: OneHopNode;
};

// Default TTL for deep research results (24 hours)
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
// Maximum number of refinement loops
const MAX_SEARCH_LOOPS = 4;

/**
 * Main job handler for deep research
 * @param data Job parameters including userId, conversationId, messages, and lastNMessages
 */
export async function performDeepResearch(
  data: DeepResearchJobInput,
): Promise<void> {
  const { userId, conversationId, messages, lastNMessages } = data;
  const db = await useDatabase();

  console.log(`Starting deep research for conversation ${conversationId}`);

  try {
    // Prepare initial queries based on recent conversation turns
    const recentMessages = messages
      .slice(-lastNMessages)
      .filter((m) => m.role === "user" || m.role === "assistant");
    const queries = await generateSearchQueries(userId, recentMessages);

    if (queries.length === 0) {
      console.log("No meaningful search queries generated for deep research");
      return;
    }

    // Run iterative search/refine loop
    const searchResults = await runIterativeSearch(
      db,
      userId,
      recentMessages,
      queries,
    );

    // Cache the combined results
    await cacheDeepResearchResults(userId, conversationId, [searchResults]);

    console.log(`Deep research completed for conversation ${conversationId}`);
  } catch (error) {
    console.error(
      `Deep research failed for conversation ${conversationId}:`,
      error,
    );
  }
}

/**
 * Generate search queries based on recent conversation messages
 */
async function generateSearchQueries(
  userId: string,
  messages: DeepResearchJobInput["messages"],
): Promise<string[]> {
  const schema = z
    .object({ queries: z.array(z.string()).min(1).max(5) })
    .describe("DeepResearchQueries");

  // Format messages for context
  const messageContext = messages
    .map((m) => `<message role="${m.role}">${escapeXml(m.content)}</message>`)
    .join("\n");

  // Use structured analysis to generate tangential search queries
  try {
    const res = await performStructuredAnalysis({
      userId,
      systemPrompt:
        "You are an imaginative research assistant generating tangential search queries.",
      prompt: `<system:info>You are processing a conversation and want to find interesting background or related topics that are not necessarily direct continuations.</system:info>

<conversation>
${messageContext}
</conversation>

<system:instruction>
Come up with 1-5 search queries that explore adjacent or less obvious connections to the conversation. Avoid simply rephrasing what was said. Think of historical context, supporting facts or surprising angles that could provide useful background knowledge.
</system:instruction>`,
      schema,
    });

    return res["queries"];
  } catch (error) {
    console.error("Failed to generate search queries:", error);
    return [];
  }
}

/**
 * Run iterative search with LLM refinement.
 */
async function runIterativeSearch(
  db: DrizzleDB,
  userId: string,
  messages: DeepResearchJobInput["messages"],
  initialQueries: string[],
): Promise<RerankResult<SearchGroups>> {
  const queue = [...initialQueries];
  const history: string[] = [];
  let results: SearchResultWithId[] = [];
  let tempIdCounter = 0;
  const mapper = new TemporaryIdMapper<SearchResults[number], string>(
    () => `r${++tempIdCounter}`,
  );
  const seen = new Set<string>();
  let loops = 0;

  while (loops < MAX_SEARCH_LOOPS && queue.length > 0) {
    const query = queue.shift()!;
    history.push(query);

    const embResp = await generateEmbeddings({
      model: "jina-embeddings-v3",
      task: "retrieval.query",
      input: [query],
      truncate: true,
    });
    const embedding = embResp.data[0]?.embedding;
    if (embedding) {
      const res = await executeSearchWithEmbedding(
        db,
        userId,
        query,
        embedding,
        20,
      );
      if (res) {
        const dedup = res.filter((r) => {
          const key = `${r.group}:${r.item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        results.push(...mapper.mapItems(dedup));
      }
    }

    loops++;
    if (loops >= MAX_SEARCH_LOOPS) break;

    const refinement = await refineSearchResults(
      userId,
      messages,
      history,
      results,
    );
    if (refinement.dropIds.length) {
      const drop = new Set(refinement.dropIds);
      results = results.filter((r) => !drop.has(r.tempId));
    }
    if (refinement.done) break;
    if (refinement.nextQuery) queue.push(refinement.nextQuery);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return results.map(({ tempId, ...rest }) => rest);
}

interface RefinementResult {
  dropIds: string[];
  done: boolean;
  nextQuery?: string;
}

/**
 * Ask the LLM to refine search results.
 */
async function refineSearchResults(
  userId: string,
  messages: DeepResearchJobInput["messages"],
  queries: string[],
  results: SearchResultWithId[],
): Promise<RefinementResult> {
  const schema = z
    .object({
      dropIds: z.array(z.string()).default([]),
      done: z.boolean(),
      nextQuery: z.string().optional(),
    })
    .describe("DeepResearchRefinement");

  const messageContext = messages
    .map((m) => `<message role="${m.role}">${escapeXml(m.content)}</message>`)
    .join("\n");
  const queriesXml = queries
    .map((q) => `<query>${escapeXml(q)}</query>`)
    .join("\n");
  const resultsXml = formatSearchResultsWithIds(results);

  try {
    return (await performStructuredAnalysis({
      userId,
      systemPrompt: "You refine background search results.",
      prompt: `<conversation>
${messageContext}
</conversation>

<queries>
${queriesXml}
</queries>

<results>
${resultsXml}
</results>

<system:instruction>
Remove irrelevant results by listing their ids in dropIds. If more searching is needed, set done=false and provide nextQuery. If satisfied, set done=true.
</system:instruction>`,
      schema,
    })) as RefinementResult;
  } catch (error) {
    console.error("Failed to refine deep search results:", error);
    return { dropIds: [], done: true };
  }
}

/**
 * Execute multiple search queries in parallel with higher limits
 * and return combined results
 */

/**
 * Execute a single search with the provided embedding
 */
async function executeSearchWithEmbedding(
  db: DrizzleDB,
  userId: string,
  query: string,
  embedding: number[],
  limit: number,
): Promise<RerankResult<SearchGroups> | null> {
  try {
    const [similarNodes, similarClaims] = await Promise.all([
      findSimilarNodes({
        userId,
        embedding,
        limit,
        minimumSimilarity: 0.35, // Lower threshold for deep search
      }),
      findSimilarClaims({
        userId,
        embedding,
        limit,
        minimumSimilarity: 0.35, // Lower threshold for deep search
      }),
    ]);

    // Get one-hop connections
    const nodeIds = new Set([
      ...similarNodes.map((node) => node.id),
      ...similarClaims.flatMap((claim) =>
        claim.objectNodeId
          ? [claim.subjectNodeId, claim.objectNodeId]
          : [claim.subjectNodeId],
      ),
    ]);

    const connections = await findOneHopNodes(db, userId, Array.from(nodeIds));

    // Build search result items without reranking
    const allResults: RerankResult<SearchGroups> = [
      ...similarNodes.map((n) => ({
        group: "similarNodes" as const,
        item: n,
        relevance_score: n.similarity,
      })),
      ...similarClaims.map((claim) => ({
        group: "similarClaims" as const,
        item: claim,
        relevance_score: claim.similarity,
      })),
      ...connections.map((c) => ({
        group: "connections" as const,
        item: c,
        relevance_score: 0,
      })),
    ];

    // Randomize before applying the limit
    const results = shuffleArray(allResults).slice(0, limit);

    return results;
  } catch (error) {
    console.error("Error in executeSearchWithEmbedding:", error);
    return null;
  }
}

/**
 * Cache the deep research results with TTL
 */
async function cacheDeepResearchResults(
  userId: string,
  conversationId: string,
  results: RerankResult<SearchGroups>[],
): Promise<void> {
  if (!results || results.length === 0) {
    console.log("No results to cache for deep research");
    return;
  }

  // Flatten results
  const validResults = results.flat();

  const ttl = DEFAULT_TTL_SECONDS;
  const now = new Date();

  const result: DeepResearchResult = {
    userId,
    conversationId,
    results: validResults,
    timestamp: now,
    ttl,
  };

  await storeDeepResearchResult(result);
}
