/**
 * Story 8 — Assistant fabrication (trust rule + filter).
 *
 * Two pieces, both pinning the lifecycle trust rule and the default-search
 * filter:
 *
 *   1. Filter: a fabricated `assistant_inferred` claim on a real subject is
 *      hidden from the default-surface filter
 *      (`status='active' AND scope='personal' AND assertedByKind <> 'assistant_inferred'`)
 *      while the legitimate user claim remains visible.
 *
 *   2. Trust rule: when the assistant fabricates a single-valued claim on the
 *      same (subject, predicate) as a `user`-asserted truth, the lifecycle
 *      engine's `trustRuleDemotedClaimId` forces the fabrication into the
 *      `superseded` slot regardless of timestamp ordering. We assert
 *      `superseded_by_claim_id` directly so a mutation that swaps the
 *      comparator (or removes the demotion) trips this assertion immediately.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq, ne, sql } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story08AssistantFabrication: EvalFixture = {
  name: "08-assistant-fabrication",
  description:
    "Fabricated assistant claim is filtered from default surfaces; on a single-valued predicate the trust rule forces it superseded by the contradicting user claim.",
  setup: async (ctx) => {
    await seedNode(ctx, { name: "user", type: "Person", label: "Marcel" });
    await seedSource(ctx, { name: "convA", type: "conversation" });

    // Filter case (multi-valued HAS_PREFERENCE): both rows stay `active`,
    // so the default-search filter is the only thing distinguishing them.
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

    // Trust-rule case (single-valued HAS_STATUS): a contradicting fabrication
    // is forced into `superseded` no matter how recent it is. Distinct subject
    // so the HAS_STATUS chain is independent of the filter case above.
    await seedNode(ctx, {
      name: "userTrust",
      type: "Person",
      label: "Marcel (trust pair)",
    });
    await seedClaim(ctx, {
      name: "userTrueStatus",
      subjectName: "userTrust",
      predicate: "HAS_STATUS",
      objectValue: "sober",
      sourceName: "convA",
      assertedByKind: "user",
      statement: "Marcel said he is sober.",
      statedAt: new Date("2026-04-20T10:00:00Z"),
    });
    await seedClaim(ctx, {
      name: "assistantFabricatedStatus",
      subjectName: "userTrust",
      predicate: "HAS_STATUS",
      objectValue: "drunk",
      sourceName: "convA",
      assertedByKind: "assistant_inferred",
      statement: "Assistant fabricated that Marcel is drunk.",
      statedAt: new Date("2026-04-29T10:00:00Z"),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        await applyLifecycleByName(ctx, [
          "userTrueStatus",
          "assistantFabricatedStatus",
        ]);
      },
    },
  ],
  expectations: {
    custom: [
      {
        description:
          "default-search filter returns the user HAS_PREFERENCE only; the multi-valued fabrication is invisible but stored",
        run: async (ctx) => {
          const [filteredRow] = await ctx.db
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
          if ((filteredRow?.count ?? 0) !== 1) {
            return {
              pass: false,
              message: `default filter returned ${filteredRow?.count}; expected 1`,
            };
          }
          // Both HAS_PREFERENCE rows must remain stored — the filter hides,
          // not deletes.
          const [allPrefRow] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.predicate, "HAS_PREFERENCE"),
              ),
            );
          if ((allPrefRow?.count ?? 0) !== 2) {
            return {
              pass: false,
              message: `total HAS_PREFERENCE rows=${allPrefRow?.count}; expected 2`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "trust rule: fabricated assistant_inferred HAS_STATUS is superseded by the user claim (status + supersededByClaimId cross-check)",
        run: async (ctx) => {
          // The `supersededByClaimId` cross-check is load-bearing: it catches
          // both a comparator inversion (fabrication ends up active) and a
          // "trust rule no-ops" mutation (both rows remain active, link is
          // null) — counting statuses alone would miss the latter.
          const [userTrue] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("userTrueStatus")!));
          const [assistantFab] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("assistantFabricatedStatus")!));
          if (!userTrue || !assistantFab) {
            return { pass: false, message: "trust-pair claims missing" };
          }
          if (userTrue.status !== "active") {
            return {
              pass: false,
              message: `userTrue.status=${userTrue.status}, expected active`,
            };
          }
          if (assistantFab.status !== "superseded") {
            return {
              pass: false,
              message: `assistantFab.status=${assistantFab.status}, expected superseded (trust rule must demote fabrication)`,
            };
          }
          if (assistantFab.supersededByClaimId !== userTrue.id) {
            return {
              pass: false,
              message: `assistantFab.supersededByClaimId=${assistantFab.supersededByClaimId}, expected ${userTrue.id} (fabrication must point at the user claim that demoted it)`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
