/**
 * Redis-backed cache for the bootstrap `ContextBundle`.
 *
 * One key per user/access scope, JSON-serialised, validated through Zod on
 * read so a corrupted or stale-shape payload triggers a rebuild rather than
 * crashing the request. TTL is 6 hours — atlas refreshes daily, so a missed
 * supersession-driven invalidation still expires in well under a day.
 *
 * Mirrors `deep-research-cache.ts` ergonomics. Common aliases: bootstrap
 * cache, context bundle cache, read-model cache.
 */
import { contextBundleSchema, type ContextBundle } from "./types";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
import { shouldSkipJobEnqueue } from "~/utils/test-overrides";

const CONTEXT_BUNDLE_PREFIX = "context-bundle:";
const TTL_SECONDS = 6 * 60 * 60;

interface ContextCacheClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    ttlSeconds: number,
  ): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

const inMemoryCache = new Map<string, { value: string; expiresAt: number }>();

const inMemoryCacheClient: ContextCacheClient = {
  async get(key) {
    const entry = inMemoryCache.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
      inMemoryCache.delete(key);
      return null;
    }
    return entry.value;
  },
  async set(key, value, _expiryMode, ttlSeconds) {
    inMemoryCache.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  },
  async del(key) {
    inMemoryCache.delete(key);
  },
};

function buildKey(
  userId: string,
  partitionKey?: ContextPartitionKey,
  accessScope?: MemoryAccessScope | undefined,
): string {
  return `${CONTEXT_BUNDLE_PREFIX}${JSON.stringify([
    userId,
    partitionKey ?? null,
    accessScope ?? "partition",
  ])}`;
}

async function getCacheClient(): Promise<ContextCacheClient> {
  if (shouldSkipJobEnqueue()) return inMemoryCacheClient;
  const { redisConnection } = await import("../queues");
  return {
    get: (key) => redisConnection.get(key),
    set: (key, value, expiryMode, ttlSeconds) =>
      redisConnection.set(key, value, expiryMode, ttlSeconds),
    del: (key) => redisConnection.del(key),
  };
}

export async function getCachedBundle(
  userId: string,
  partitionKey?: ContextPartitionKey,
  accessScope?: MemoryAccessScope | undefined,
): Promise<ContextBundle | null> {
  try {
    const client = await getCacheClient();
    const data = await client.get(buildKey(userId, partitionKey, accessScope));
    if (!data) return null;
    const parsed = contextBundleSchema.safeParse(JSON.parse(data));
    if (!parsed.success) {
      // Stale payload shape — drop it so the next call rebuilds cleanly.
      await client.del(buildKey(userId, partitionKey, accessScope));
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
  partitionKey?: ContextPartitionKey,
  accessScope?: MemoryAccessScope | undefined,
): Promise<void> {
  try {
    const client = await getCacheClient();
    await client.set(
      buildKey(userId, partitionKey, accessScope),
      JSON.stringify(bundle),
      "EX",
      TTL_SECONDS,
    );
  } catch (error) {
    console.error("Failed to write cached context bundle:", error);
  }
}

export async function invalidateCachedBundle(
  userId: string,
  partitionKey?: ContextPartitionKey,
  accessScope?: MemoryAccessScope | undefined,
): Promise<void> {
  try {
    const client = await getCacheClient();
    const keys = [buildKey(userId, partitionKey, accessScope)];
    // A partition supersession changes the aggregate workspace view too. The
    // workspace key has no partition component by design, so evict it as a
    // dependent read model without touching unrelated partition bundles.
    if (accessScope !== "workspace") {
      keys.push(buildKey(userId, undefined, "workspace"));
    }
    await Promise.all(keys.map((key) => client.del(key)));
  } catch (error) {
    console.error("Failed to invalidate cached context bundle:", error);
  }
}
