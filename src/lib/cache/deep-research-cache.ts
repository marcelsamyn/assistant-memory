import { redisConnection } from "../queues";
import {
  DeepResearchResult,
  DeepResearchResultSchema,
} from "../schemas/deep-research";
import type { ContextPartitionKey } from "../schemas/partition";

// Redis client from shared connection
const redisClient = redisConnection;

/**
 * Prefix for deep research cache keys to avoid collisions
 */
const DEEP_RESEARCH_PREFIX = "deep-research:";

/**
 * Build a consistent Redis key for deep research results
 */
function buildDeepResearchKey(
  userId: string,
  conversationId: string,
  partitionKey?: ContextPartitionKey,
): string {
  return `${DEEP_RESEARCH_PREFIX}${JSON.stringify([
    userId,
    partitionKey ?? null,
    conversationId,
  ])}`;
}

/**
 * Store deep research results in Redis with TTL
 */
export async function storeDeepResearchResult(
  result: DeepResearchResult,
): Promise<void> {
  const { userId, partitionKey, conversationId, ttl } = result;
  const key = buildDeepResearchKey(userId, conversationId, partitionKey);

  try {
    // Serialize with JSON
    await redisClient.set(key, JSON.stringify(result), "EX", ttl);
    console.log(
      `Stored deep research results for conversation ${conversationId}, expires in ${ttl}s`,
    );
  } catch (error) {
    console.error("Failed to store deep research results:", error);
  }
}

/**
 * Retrieve deep research results from Redis
 * Returns null if not found or expired
 */
export async function getDeepResearchResult(
  userId: string,
  conversationId: string,
  partitionKey?: ContextPartitionKey,
): Promise<DeepResearchResult | null> {
  const key = buildDeepResearchKey(userId, conversationId, partitionKey);

  try {
    const data = await redisClient.get(key);
    if (!data) return null;

    // Parse the data and validate through schema to ensure correct structure
    const parsedData = JSON.parse(data);

    // Use Zod to validate and convert data (timestamp conversion happens automatically)
    const result = DeepResearchResultSchema.parse(parsedData);
    if (
      result.userId !== userId ||
      result.conversationId !== conversationId ||
      result.partitionKey !== partitionKey
    ) {
      return null;
    }
    return result;
  } catch (error) {
    console.error("Failed to retrieve deep research results:", error);
    return null;
  }
}
