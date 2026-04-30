/**
 * Stub builders for the extraction LLM and source service used by the eval
 * harness. The harness flips on the seams in `~/utils/test-overrides` for the
 * lifetime of a fixture; production stays untouched.
 *
 * Common aliases: extraction stub client, FIFO LLM stub, harness source
 * service, mock insertMany.
 */
import { sources, type SourcesInsert } from "~/db/schema";
import type { SourceCreateInput } from "~/lib/sources";
import { type DrizzleDB } from "~/db";
import type {
  StubCompletionClient,
  StubSourceService,
} from "~/utils/test-overrides";
import { newTypeId, type TypeId } from "~/types/typeid";
import type { ExtractionStubResponse } from "./types";

/**
 * Build a FIFO-consuming completion client. Each call to
 * `beta.chat.completions.parse` returns the next queued response. Throws on
 * underflow so a story that wires fewer responses than its message count
 * fails loudly.
 */
export function createExtractionStubClient(
  responses: ExtractionStubResponse[],
): { client: StubCompletionClient; remaining: () => number } {
  const queue: ExtractionStubResponse[] = [...responses];

  const client: StubCompletionClient = {
    beta: {
      // The production caller only reads `choices[0].message.parsed`. We
      // satisfy that surface and ignore everything else.
      chat: {
        completions: {
          parse: async () => {
            const next = queue.shift();
            if (!next) {
              throw new Error(
                "Extraction stub queue exhausted: production code requested more LLM responses than were queued.",
              );
            }
            return {
              choices: [
                {
                  message: {
                    parsed: {
                      nodes: next.nodes ?? [],
                      relationshipClaims: next.relationshipClaims ?? [],
                      attributeClaims: next.attributeClaims ?? [],
                      aliases: next.aliases ?? [],
                    },
                  },
                },
              ],
            };
          },
        },
      },
    },
    // The production caller never invokes `client.chat.completions.create`
    // (text completion) or `client.embeddings.*` directly during extraction;
    // those code paths are gated by other test-overrides seams.
  } as unknown as StubCompletionClient;

  return { client, remaining: () => queue.length };
}

/**
 * Build a SQL-only `SourceService.insertMany` that mirrors production's
 * row-shape and inline-content handling, but skips MinIO entirely. Mirrors
 * the helper in `ingest-transcript.test.ts` so transcript ingestion runs
 * deterministically against the harness DB.
 */
export function createStubSourceService(db: DrizzleDB): StubSourceService {
  return {
    async insertMany(inputs: SourceCreateInput[]) {
      const successes: TypeId<"source">[] = [];
      for (const input of inputs) {
        const id = newTypeId("source");
        const metadata = {
          ...(input.metadata ?? {}),
          ...(input.content !== undefined
            ? { rawContent: input.content }
            : {}),
        };
        const values: SourcesInsert = {
          id,
          userId: input.userId,
          type: input.sourceType,
          externalId: input.externalId,
          parentSource: input.parentId ?? null,
          scope: input.scope ?? "personal",
          metadata,
          lastIngestedAt: input.timestamp,
          status: "completed",
        };
        const [inserted] = await db
          .insert(sources)
          .values(values)
          .onConflictDoNothing({
            target: [sources.userId, sources.type, sources.externalId],
          })
          .returning();
        if (inserted) successes.push(inserted.id);
      }
      return { successes, failures: [] };
    },
  };
}

