/**
 * Story 4 — Assistant suggestion not confirmed.
 *
 * The assistant says "It sounds like you might be a software engineer."
 * The user does not respond. Extraction should mark this as
 * `assertedByKind = "assistant_inferred"`. Default `searchMemory` filters it
 * out; opting in with `includeAssistantInferred` (or the equivalent flag on
 * the underlying `findSimilarClaims`) returns it.
 *
 * Asserts the underlying invariant: an `assistant_inferred` claim is excluded
 * from default-filter queries (status='active' AND
 * assertedByKind <> 'assistant_inferred'), but is reachable when the filter
 * is dropped.
 */
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq, ne, sql } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story04AssistantSuggestionNotConfirmed: EvalFixture = {
  name: "04-assistant-suggestion-not-confirmed",
  description:
    "An unconfirmed assistant inference is filtered from default search but reachable via the deep path.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "user",
      type: "Person",
      label: "Marcel",
    });
    await seedSource(ctx, { name: "convA", type: "conversation" });
    await seedClaim(ctx, {
      name: "inferredOccupation",
      subjectName: "user",
      predicate: "HAS_PREFERENCE",
      objectValue: "software engineer",
      sourceName: "convA",
      assertedByKind: "assistant_inferred",
      statement: "Assistant guessed Marcel is a software engineer.",
    });
  },
  steps: [],
  expectations: {
    claimCounts: [
      {
        description: "the inference is stored as assistant_inferred",
        assertedByKind: "assistant_inferred",
        exactCount: 1,
      },
    ],
    custom: [
      {
        description:
          "default search filter (kind != assistant_inferred) excludes the inference, deep filter still finds it",
        run: async (ctx) => {
          const [defaultRow] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                eq(claims.scope, "personal"),
                ne(claims.assertedByKind, "assistant_inferred"),
              ),
            );
          const [deepRow] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(eq(claims.userId, ctx.userId), eq(claims.status, "active")),
            );
          if ((defaultRow?.count ?? 0) !== 0) {
            return {
              pass: false,
              message: `default search returned ${defaultRow?.count}; expected 0`,
            };
          }
          if ((deepRow?.count ?? 0) !== 1) {
            return {
              pass: false,
              message: `deep search returned ${deepRow?.count}; expected 1`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
