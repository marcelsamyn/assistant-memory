import type { DeepResearchResult } from "../schemas/deep-research";
import { contextPartitionKeySchema } from "../schemas/partition";
import {
  getDeepResearchResult,
  storeDeepResearchResult,
} from "./deep-research-cache";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => new Map<string, string>());

vi.mock("../queues", () => ({
  redisConnection: {
    get: async (key: string) => cache.get(key) ?? null,
    set: async (key: string, value: string) => {
      cache.set(key, value);
      return "OK";
    },
  },
}));

const emptyResults: DeepResearchResult["results"] = [];

describe("deep research cache partition isolation", () => {
  beforeEach(() => cache.clear());

  it("keeps delimiter-bearing partition tuples distinct", async () => {
    const firstPartition = contextPartitionKeySchema.parse("opaque:a");
    const secondPartition = contextPartitionKeySchema.parse("opaque");
    await storeDeepResearchResult({
      userId: "cache-user",
      partitionKey: firstPartition,
      conversationId: "b:c",
      results: emptyResults,
      timestamp: new Date(),
      ttl: 60,
    });
    await storeDeepResearchResult({
      userId: "cache-user",
      partitionKey: secondPartition,
      conversationId: "a:b:c",
      results: emptyResults,
      timestamp: new Date(),
      ttl: 60,
    });

    expect(cache).toHaveLength(2);
    await expect(
      getDeepResearchResult("cache-user", "b:c", firstPartition),
    ).resolves.toMatchObject({ conversationId: "b:c" });
    await expect(
      getDeepResearchResult("cache-user", "a:b:c", secondPartition),
    ).resolves.toMatchObject({ conversationId: "a:b:c" });
  });

  it("rejects a cached result whose identity does not match its key", async () => {
    const partitionKey = contextPartitionKeySchema.parse("opaque:bound");
    await storeDeepResearchResult({
      userId: "cache-user",
      partitionKey,
      conversationId: "conversation-a",
      results: emptyResults,
      timestamp: new Date(),
      ttl: 60,
    });
    const [key, value] = [...cache.entries()][0]!;
    cache.set(
      key,
      JSON.stringify({
        ...JSON.parse(value),
        conversationId: "conversation-b",
      }),
    );

    await expect(
      getDeepResearchResult("cache-user", "conversation-a", partitionKey),
    ).resolves.toBeNull();
  });
});
