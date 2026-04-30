/**
 * Story 17 — Trust hierarchy matrix.
 *
 * Pins the trust comparator in `~/lib/claims/lifecycle.ts`:
 *   user_confirmed > user > participant > document_author >
 *   assistant_inferred > system
 *
 * For each adjacent pair we seed two HAS_STATUS claims with the same subject,
 * predicate and object_value but different `assertedByKind`, statedAt 1 second
 * apart. The lifecycle engine should leave the higher-trust claim active and
 * mark the lower-trust claim superseded.
 *
 * Lifecycle ordering is `statedAt` first, `createdAt` second, trust rank only
 * a tiebreaker. To make the trust rule the load-bearing axis (rather than
 * recency), we set the *higher-trust* claim to be the *later* statedAt — so
 * the assertion really pins "the higher-trust claim wins" against any
 * future change that reorders the comparator.
 *
 * Additionally:
 * - `system` vs `user_confirmed` (non-adjacent): `user_confirmed` wins.
 * - Equal trust (`user` vs `user`): the later-statedAt claim wins (recency
 *   tiebreaker).
 *
 * Each pair gets its own subject Concept to prevent cross-talk. Mutations
 * that would trip each assertion: swapping the comparator's sign, removing a
 * tier from `ASSERTED_BY_KIND_TRUST_RANK`, or merging tiers.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalContext, EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";
import type { AssertedByKind } from "~/types/graph";

interface TrustPair {
  subjectName: string;
  lowerKind: AssertedByKind;
  higherKind: AssertedByKind;
  lowerClaim: string;
  higherClaim: string;
  /** Description of the hierarchy rule this pair pins. */
  rationale: string;
}

const PAIRS: TrustPair[] = [
  {
    subjectName: "subj_uc_vs_u",
    lowerKind: "user",
    higherKind: "user_confirmed",
    lowerClaim: "claim_uc_vs_u_low",
    higherClaim: "claim_uc_vs_u_high",
    rationale: "user_confirmed > user",
  },
  {
    subjectName: "subj_u_vs_p",
    lowerKind: "participant",
    higherKind: "user",
    lowerClaim: "claim_u_vs_p_low",
    higherClaim: "claim_u_vs_p_high",
    rationale: "user > participant",
  },
  {
    subjectName: "subj_p_vs_d",
    lowerKind: "document_author",
    higherKind: "participant",
    lowerClaim: "claim_p_vs_d_low",
    higherClaim: "claim_p_vs_d_high",
    rationale: "participant > document_author",
  },
  {
    subjectName: "subj_d_vs_a",
    lowerKind: "assistant_inferred",
    higherKind: "document_author",
    lowerClaim: "claim_d_vs_a_low",
    higherClaim: "claim_d_vs_a_high",
    rationale: "document_author > assistant_inferred",
  },
  {
    subjectName: "subj_a_vs_s",
    lowerKind: "system",
    higherKind: "assistant_inferred",
    lowerClaim: "claim_a_vs_s_low",
    higherClaim: "claim_a_vs_s_high",
    rationale: "assistant_inferred > system",
  },
  // Non-adjacent: full skip from the bottom to the top.
  {
    subjectName: "subj_s_vs_uc",
    lowerKind: "system",
    higherKind: "user_confirmed",
    lowerClaim: "claim_s_vs_uc_low",
    higherClaim: "claim_s_vs_uc_high",
    rationale: "user_confirmed beats system across all skipped tiers",
  },
];

const BASE_INSTANT = new Date("2026-04-25T09:00:00Z").getTime();

/**
 * Note on the participant pair: a `participant` claim must carry a non-null
 * `assertedByNodeId` (enforced by `claims_asserted_by_node_consistency_ck`).
 * The harness seeds a single "Speaker" Person node and points every
 * participant-kind seed claim at it; lifecycle supersession itself only
 * inspects `statedAt`/`createdAt`/`assertedByKind`/`id`, so the asserter
 * id has no influence on the trust ranking under test.
 */

async function assertWinner(
  ctx: EvalContext,
  pair: TrustPair,
): Promise<string | null> {
  const [low] = await ctx.db
    .select()
    .from(claims)
    .where(eq(claims.id, ctx.claims.get(pair.lowerClaim)!));
  const [high] = await ctx.db
    .select()
    .from(claims)
    .where(eq(claims.id, ctx.claims.get(pair.higherClaim)!));
  if (!low || !high) {
    return `${pair.rationale}: claims missing post-lifecycle`;
  }
  if (high.status !== "active") {
    return `${pair.rationale}: higher (${pair.higherKind}).status=${high.status}, expected active`;
  }
  if (low.status !== "superseded") {
    return `${pair.rationale}: lower (${pair.lowerKind}).status=${low.status}, expected superseded`;
  }
  if (low.supersededByClaimId !== high.id) {
    return `${pair.rationale}: lower.supersededByClaimId=${low.supersededByClaimId}, expected ${high.id}`;
  }
  return null;
}

export const story17TrustHierarchyMatrix: EvalFixture = {
  name: "17-trust-hierarchy-matrix",
  description:
    "Lifecycle trust comparator pins user_confirmed > user > participant > document_author > assistant_inferred > system, plus non-adjacent skip and equal-trust recency tiebreak.",
  setup: async (ctx) => {
    await seedSource(ctx, { name: "src", type: "conversation" });
    // Asserter node — required by the `claims_asserted_by_node_consistency_ck`
    // check constraint for any `participant`-asserted claim.
    await seedNode(ctx, {
      name: "speaker",
      type: "Person",
      label: "Speaker",
    });

    // Seed every (lower, higher) pair with the higher-trust claim being the
    // later-statedAt row. Lifecycle should pick the higher-trust claim as
    // active.
    let cursor = BASE_INSTANT;
    for (const pair of PAIRS) {
      await seedNode(ctx, {
        name: pair.subjectName,
        type: "Concept",
        label: pair.subjectName,
      });

      // Lower-trust claim, earlier statedAt.
      await seedClaim(ctx, {
        name: pair.lowerClaim,
        subjectName: pair.subjectName,
        predicate: "HAS_STATUS",
        objectValue: "in_progress",
        sourceName: "src",
        statement: `${pair.subjectName} status (lower=${pair.lowerKind})`,
        assertedByKind: pair.lowerKind,
        ...(pair.lowerKind === "participant"
          ? { assertedByNodeName: "speaker" }
          : {}),
        statedAt: new Date(cursor),
      });
      // Higher-trust claim, 1 second later.
      await seedClaim(ctx, {
        name: pair.higherClaim,
        subjectName: pair.subjectName,
        predicate: "HAS_STATUS",
        objectValue: "in_progress",
        sourceName: "src",
        statement: `${pair.subjectName} status (higher=${pair.higherKind})`,
        assertedByKind: pair.higherKind,
        ...(pair.higherKind === "participant"
          ? { assertedByNodeName: "speaker" }
          : {}),
        statedAt: new Date(cursor + 1000),
      });
      cursor += 60_000;
    }

    // Equal-trust pair — two `user` claims with same value, 1s apart. Later
    // wins via recency tiebreaker.
    await seedNode(ctx, {
      name: "subj_equal",
      type: "Concept",
      label: "subj_equal",
    });
    await seedClaim(ctx, {
      name: "equal_earlier",
      subjectName: "subj_equal",
      predicate: "HAS_STATUS",
      objectValue: "in_progress",
      sourceName: "src",
      statement: "equal-trust earlier",
      assertedByKind: "user",
      statedAt: new Date(cursor),
    });
    await seedClaim(ctx, {
      name: "equal_later",
      subjectName: "subj_equal",
      predicate: "HAS_STATUS",
      objectValue: "in_progress",
      sourceName: "src",
      statement: "equal-trust later",
      assertedByKind: "user",
      statedAt: new Date(cursor + 1000),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        const allNames: string[] = [];
        for (const pair of PAIRS) {
          allNames.push(pair.lowerClaim, pair.higherClaim);
        }
        allNames.push("equal_earlier", "equal_later");
        await applyLifecycleByName(ctx, allNames);
      },
    },
  ],
  expectations: {
    custom: [
      ...PAIRS.map((pair) => ({
        description: `lifecycle pins ${pair.rationale}`,
        run: async (ctx: EvalContext) => {
          const failure = await assertWinner(ctx, pair);
          if (failure) return { pass: false, message: failure };
          return { pass: true };
        },
      })),
      {
        description:
          "equal-trust (user vs user): later statedAt wins via recency tiebreaker",
        run: async (ctx) => {
          const [earlier] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("equal_earlier")!));
          const [later] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("equal_later")!));
          if (!earlier || !later) {
            return { pass: false, message: "equal-trust claims missing" };
          }
          if (later.status !== "active") {
            return {
              pass: false,
              message: `later.status=${later.status}, expected active`,
            };
          }
          if (earlier.status !== "superseded") {
            return {
              pass: false,
              message: `earlier.status=${earlier.status}, expected superseded`,
            };
          }
          if (earlier.supersededByClaimId !== later.id) {
            return {
              pass: false,
              message: `earlier.supersededByClaimId=${earlier.supersededByClaimId}, expected ${later.id}`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
