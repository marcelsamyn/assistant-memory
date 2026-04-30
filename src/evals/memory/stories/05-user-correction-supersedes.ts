/**
 * Story 5 — User correction supersedes (and the trust rule pins later
 * assistant_inferred behind earlier user).
 *
 * Two-part fixture, both pinning the same load-bearing comparator in
 * `~/lib/claims/lifecycle.ts`:
 *
 *   1. Vanilla supersession: "I work at Acme" → "Actually I work at Bravo".
 *      Two `user`-asserted HAS_STATUS claims; the later one supersedes.
 *
 *   2. Trust rule: a prior `user` HAS_STATUS claim and a later
 *      `assistant_inferred` claim contradicting it. Even though the
 *      assistant claim is later by `statedAt`, the trust rule
 *      (`trustRuleDemotedClaimId`) forces the assistant claim into the
 *      `superseded` slot and keeps the user claim active. The custom
 *      assertion cross-checks `superseded_by_claim_id` so a future mutation
 *      that "leaves both active" or swaps the comparator's sign also trips
 *      the test (raw status counts alone would miss those).
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story05UserCorrectionSupersedes: EvalFixture = {
  name: "05-user-correction-supersedes",
  description:
    "User correction supersedes prior status; trust rule keeps a later assistant_inferred claim from displacing a prior user claim.",
  setup: async (ctx) => {
    await seedNode(ctx, { name: "user", type: "Person", label: "Marcel" });
    await seedSource(ctx, { name: "conv1", type: "conversation" });
    await seedSource(ctx, { name: "conv2", type: "conversation" });
    await seedSource(ctx, { name: "convA", type: "conversation" });

    // Part 1 — vanilla supersession on (user, user) HAS_STATUS pair.
    await seedClaim(ctx, {
      name: "acme",
      subjectName: "user",
      predicate: "HAS_STATUS",
      objectValue: "works_at_acme",
      sourceName: "conv1",
      statement: "Marcel works at Acme.",
      statedAt: new Date("2026-04-15T10:00:00Z"),
    });
    await seedClaim(ctx, {
      name: "bravo",
      subjectName: "user",
      predicate: "HAS_STATUS",
      objectValue: "works_at_bravo",
      sourceName: "conv2",
      statement: "Actually, Marcel works at Bravo now.",
      statedAt: new Date("2026-04-28T10:00:00Z"),
    });

    // Part 2 — trust rule. Distinct subject so the two parts do not
    // share a HAS_STATUS chain.
    await seedNode(ctx, {
      name: "userTrust",
      type: "Person",
      label: "Marcel (trust pair)",
    });
    await seedClaim(ctx, {
      name: "userClaim",
      subjectName: "userTrust",
      predicate: "HAS_STATUS",
      objectValue: "happy",
      sourceName: "convA",
      statement: "Marcel said he is happy.",
      assertedByKind: "user",
      statedAt: new Date("2026-04-15T10:00:00Z"),
    });
    // Assistant_inferred contradicting claim, *later* by statedAt. Without
    // the trust rule, recency would let it win; with the rule, it is forced
    // superseded.
    await seedClaim(ctx, {
      name: "assistantClaim",
      subjectName: "userTrust",
      predicate: "HAS_STATUS",
      objectValue: "stressed",
      sourceName: "convA",
      statement: "Assistant inferred Marcel might be stressed.",
      assertedByKind: "assistant_inferred",
      statedAt: new Date("2026-04-29T10:00:00Z"),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        await applyLifecycleByName(ctx, [
          "acme",
          "bravo",
          "userClaim",
          "assistantClaim",
        ]);
      },
    },
  ],
  expectations: {
    custom: [
      {
        description:
          "vanilla supersession: bravo active, acme superseded by bravo",
        run: async (ctx) => {
          const [acme] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("acme")!));
          const [bravo] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("bravo")!));
          if (!acme || !bravo) {
            return { pass: false, message: "vanilla pair claims missing" };
          }
          if (bravo.status !== "active") {
            return {
              pass: false,
              message: `bravo.status=${bravo.status}, expected active`,
            };
          }
          if (acme.status !== "superseded") {
            return {
              pass: false,
              message: `acme.status=${acme.status}, expected superseded`,
            };
          }
          if (acme.supersededByClaimId !== bravo.id) {
            return {
              pass: false,
              message: `acme.supersededByClaimId=${acme.supersededByClaimId}, expected ${bravo.id}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "trust rule: later assistant_inferred is forced superseded by earlier user claim (status + supersededByClaimId cross-check)",
        run: async (ctx) => {
          // We assert on `superseded_by_claim_id` rather than raw status
          // counts. A future mutation that swaps the comparator sign or
          // skips demotion entirely (leaving both `active`) trips this same
          // assertion — the link from assistant→user claim is the
          // load-bearing structural pin.
          const [userClaim] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("userClaim")!));
          const [assistantClaim] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("assistantClaim")!));
          if (!userClaim || !assistantClaim) {
            return { pass: false, message: "trust-pair claims missing" };
          }
          if (userClaim.assertedByKind !== "user") {
            return {
              pass: false,
              message: `userClaim.assertedByKind=${userClaim.assertedByKind}, expected user (sanity)`,
            };
          }
          if (assistantClaim.assertedByKind !== "assistant_inferred") {
            return {
              pass: false,
              message: `assistantClaim.assertedByKind=${assistantClaim.assertedByKind}, expected assistant_inferred (sanity)`,
            };
          }
          if (userClaim.status !== "active") {
            return {
              pass: false,
              message: `userClaim.status=${userClaim.status}, expected active`,
            };
          }
          if (assistantClaim.status !== "superseded") {
            return {
              pass: false,
              message: `assistantClaim.status=${assistantClaim.status}, expected superseded (trust rule)`,
            };
          }
          if (assistantClaim.supersededByClaimId !== userClaim.id) {
            return {
              pass: false,
              message: `assistantClaim.supersededByClaimId=${assistantClaim.supersededByClaimId}, expected ${userClaim.id} (trust rule must point at the user claim)`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
