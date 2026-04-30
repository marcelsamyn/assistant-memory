/**
 * Story 8 — Assistant fabrication (assertedByKind filtering).
 *
 * The assistant fabricates a fact about the user. Even if the underlying
 * subject node is reachable via personal-scope claims, the
 * `assistant_inferred` claim must NOT surface in default search /
 * getOpenCommitments / atlas paths. We assert the production filter
 * predicate (`status='active' AND scope='personal' AND
 * assertedByKind <> 'assistant_inferred'`) drops the fabrication while still
 * allowing the legitimate user claim through.
 */
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq, ne, sql } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story08AssistantFabrication: EvalFixture = {
  name: "08-assistant-fabrication",
  description:
    "Assistant-inferred claim on a real subject is filtered from default surfaces while the user-asserted claim remains visible.",
  setup: async (ctx) => {
    await seedNode(ctx, { name: "user", type: "Person", label: "Marcel" });
    await seedSource(ctx, { name: "convA", type: "conversation" });
    await seedClaim(ctx, {
      name: "userTruth",
      subjectName: "user",
      predicate: "HAS_PREFERENCE",
      objectValue: "tea",
      sourceName: "convA",
      assertedByKind: "user",
      statement: "Marcel prefers tea.",
    });
    await seedClaim(ctx, {
      name: "assistantFabrication",
      subjectName: "user",
      predicate: "HAS_PREFERENCE",
      objectValue: "tequila",
      sourceName: "convA",
      assertedByKind: "assistant_inferred",
      statement: "Assistant claimed Marcel prefers tequila (fabricated).",
    });
  },
  steps: [],
  expectations: {
    custom: [
      {
        description:
          "default-search filter returns the user claim only; the fabrication is invisible",
        run: async (ctx) => {
          const rows = await ctx.db
            .select({
              count: sql<number>`count(*)::int`,
            })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                eq(claims.scope, "personal"),
                ne(claims.assertedByKind, "assistant_inferred"),
              ),
            );
          if ((rows[0]?.count ?? 0) !== 1) {
            return {
              pass: false,
              message: `default filter returned ${rows[0]?.count}; expected 1`,
            };
          }
          // The fabricated claim must remain stored, just hidden.
          const allRows = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(eq(claims.userId, ctx.userId));
          if ((allRows[0]?.count ?? 0) !== 2) {
            return {
              pass: false,
              message: `total claims=${allRows[0]?.count}; expected 2`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
