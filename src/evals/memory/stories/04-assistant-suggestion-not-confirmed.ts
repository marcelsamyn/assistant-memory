/**
 * Story 4 — Assistant suggestion not confirmed (trust rule + filter).
 *
 * Two pieces, both pinning the trust-rank comparator in
 * `~/lib/claims/lifecycle.ts`:
 *
 *   1. Filter: an `assistant_inferred` claim is excluded from the default-search
 *      filter (`status='active' AND scope='personal' AND
 *      assertedByKind <> 'assistant_inferred'`) but reachable via the deep
 *      filter that drops the kind clause.
 *
 *   2. Trust rule: when a prior `user` HAS_STATUS claim exists, a later
 *      `assistant_inferred` HAS_STATUS claim contradicting it must NOT
 *      supersede it. The lifecycle engine's `trustRuleDemotedClaimId` keeps
 *      the user claim active and forces the assistant claim into the
 *      `superseded` slot. We cross-check `superseded_by_claim_id` so a
 *      mutation that swaps the trust comparator (e.g. inverts which kind
 *      outranks) trips this assertion directly.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq, ne, sql } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story04AssistantSuggestionNotConfirmed: EvalFixture = {
  name: "04-assistant-suggestion-not-confirmed",
  description:
    "Assistant inference is filtered from default search and, via the trust rule, cannot supersede a prior user claim on the same single-valued predicate.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "user",
      type: "Person",
      label: "Marcel",
    });
    await seedSource(ctx, { name: "convA", type: "conversation" });

    // Filter case: standalone assistant_inferred claim (no user counterpart).
    await seedClaim(ctx, {
      name: "inferredOccupation",
      subjectName: "user",
      predicate: "HAS_PREFERENCE",
      objectValue: "software engineer",
      sourceName: "convA",
      assertedByKind: "assistant_inferred",
      statement: "Assistant guessed Marcel is a software engineer.",
    });

    // Trust-rule case: pair on a single-valued predicate (HAS_STATUS) so the
    // lifecycle engine's supersession path runs. Distinct subject so it doesn't
    // collide with the filter-only claim above.
    await seedNode(ctx, {
      name: "userPair",
      type: "Person",
      label: "Marcel (trust pair)",
    });
    await seedClaim(ctx, {
      name: "userPriorStatus",
      subjectName: "userPair",
      predicate: "HAS_STATUS",
      objectValue: "focused",
      sourceName: "convA",
      assertedByKind: "user",
      statement: "Marcel said he is focused.",
      statedAt: new Date("2026-04-20T10:00:00Z"),
    });
    await seedClaim(ctx, {
      name: "assistantLaterStatus",
      subjectName: "userPair",
      predicate: "HAS_STATUS",
      objectValue: "distracted",
      sourceName: "convA",
      assertedByKind: "assistant_inferred",
      statement: "Assistant suggested Marcel might be distracted.",
      statedAt: new Date("2026-04-29T10:00:00Z"),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        await applyLifecycleByName(ctx, [
          "userPriorStatus",
          "assistantLaterStatus",
        ]);
      },
    },
  ],
  expectations: {
    claimCounts: [
      {
        description:
          "both inferences are stored as assistant_inferred (HAS_PREFERENCE filter case + HAS_STATUS trust-rule case)",
        assertedByKind: "assistant_inferred",
        exactCount: 2,
      },
    ],
    custom: [
      {
        description:
          "default search filter (kind != assistant_inferred) excludes the inference, deep filter still finds it",
        run: async (ctx) => {
          // Note: only the standalone HAS_PREFERENCE assistant_inferred claim
          // is `active` after lifecycle (the HAS_STATUS one is `superseded` by
          // the trust rule, see assertion below), so the default-filter count
          // is 0 either way. We additionally narrow the WHERE to HAS_PREFERENCE
          // to keep the assertion focused on the filter shape.
          const [defaultRow] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                eq(claims.scope, "personal"),
                eq(claims.predicate, "HAS_PREFERENCE"),
                ne(claims.assertedByKind, "assistant_inferred"),
              ),
            );
          const [deepRow] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                eq(claims.predicate, "HAS_PREFERENCE"),
              ),
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
      {
        description:
          "trust rule: assistant_inferred HAS_STATUS does not supersede the prior user HAS_STATUS (status + supersededByClaimId cross-check)",
        run: async (ctx) => {
          // Asserting both `status` and `superseded_by_claim_id` lets a single
          // assertion catch both "comparator sign flipped" (assistant ends up
          // active, user ends up superseded) and "trust rule no-ops" (both
          // remain active and supersededByClaimId is null on the assistant
          // claim).
          const [userPrior] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("userPriorStatus")!));
          const [assistantLater] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("assistantLaterStatus")!));
          if (!userPrior || !assistantLater) {
            return { pass: false, message: "trust-pair claims missing" };
          }
          if (userPrior.status !== "active") {
            return {
              pass: false,
              message: `userPrior.status=${userPrior.status}, expected active (trust rule must keep prior user claim active)`,
            };
          }
          if (assistantLater.status !== "superseded") {
            return {
              pass: false,
              message: `assistantLater.status=${assistantLater.status}, expected superseded (trust rule must demote later assistant_inferred)`,
            };
          }
          if (assistantLater.supersededByClaimId !== userPrior.id) {
            return {
              pass: false,
              message: `assistantLater.supersededByClaimId=${assistantLater.supersededByClaimId}, expected ${userPrior.id} (assistant claim must point at the user claim that demoted it)`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
