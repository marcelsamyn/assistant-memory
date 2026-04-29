/**
 * Redis-backed cache for the bootstrap `ContextBundle`.
 *
 * Single key per user, JSON-serialised, validated through Zod on read so a
 * corrupted or stale-shape payload triggers a rebuild rather than crashing
 * the request. TTL is 6 hours — atlas refreshes daily, so a missed
 * supersession-driven invalidation still expires in well under a day.
 *
 * Mirrors `deep-research-cache.ts` ergonomics. Common aliases: bootstrap
 * cache, context bundle cache, read-model cache.
 */
import { redisConnection } from "../queues";
import { contextBundleSchema, type ContextBundle } from "./types";

const CONTEXT_BUNDLE_PREFIX = "context-bundle:";
const TTL_SECONDS = 6 * 60 * 60;

function buildKey(userId: string): string {
  return `${CONTEXT_BUNDLE_PREFIX}${userId}`;
}

export async function getCachedBundle(
  userId: string,
): Promise<ContextBundle | null> {
  try {
    const data = await redisConnection.get(buildKey(userId));
    if (!data) return null;
    const parsed = contextBundleSchema.safeParse(JSON.parse(data));
    if (!parsed.success) {
      // Stale payload shape — drop it so the next call rebuilds cleanly.
      await redisConnection.del(buildKey(userId));
      return null;
    }
    return parsed.data;
  } catch (error) {
    console.error("Failed to read cached context bundle:", error);
    return null;
  }
}

export async function setCachedBundle(
  userId: string,
  bundle: ContextBundle,
): Promise<void> {
  try {
    await redisConnection.set(
      buildKey(userId),
      JSON.stringify(bundle),
      "EX",
      TTL_SECONDS,
    );
  } catch (error) {
    console.error("Failed to write cached context bundle:", error);
  }
}

export async function invalidateCachedBundle(userId: string): Promise<void> {
  try {
    await redisConnection.del(buildKey(userId));
  } catch (error) {
    console.error("Failed to invalidate cached context bundle:", error);
  }
}
