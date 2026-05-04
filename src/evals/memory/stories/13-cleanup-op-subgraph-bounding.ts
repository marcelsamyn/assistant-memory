/**
 * Story 13 — Cleanup-op subgraph bounding (`allowedClaimIds`).
 *
 * Pins the `checkAllowedClaimIds` guard inside
 * `~/lib/jobs/cleanup-operations.ts`: when a claim-targeting op
 * (`retract_claim`, `contradict_claim`, `promote_assertion`) references a
 * claim id outside the rendered subgraph, the dispatcher rejects the op (no
 * row mutation; rejection recorded in `result.errors`).
 *
 * Mutation report `f906650` (M3) commented out the guard and no story
 * failed — the dispatcher's contract was unprobed. This story drives
 * `applyCleanupOperations` directly (the harness's `applyCleanupOperations`
 * step kind doesn't pass `allowedClaimIds`, so we use a `custom` assertion
 * that bypasses the step-kind boundary). Each negative case asserts (a)
 * a `result.errors` entry mentioning "outside the rendered subgraph" and
 * (b) the targeted claim's `status` is unchanged.
 *
 * One positive case at the end: retract_claim with the targeted claim in
 * `allowedClaimIds` succeeds and flips `status` to `retracted`.
 */
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalContext, EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";
import {
  applyCleanupOperations,
  type CleanupOperation,
} from "~/lib/jobs/cleanup-operations";
import type { GraphNode } from "~/lib/jobs/cleanup-graph";
import { TemporaryIdMapper } from "~/lib/temporary-id-mapper";
import type { TypeId } from "~/types/typeid";

function buildMapper(): TemporaryIdMapper<GraphNode, string> {
  // The subgraph mapper is unused by claim-targeting ops, but the dispatcher
  // requires the parameter, so we hand it an empty-but-valid instance.
  const mapper = new TemporaryIdMapper<GraphNode, string>(
    (_node, index) => `temp_node_${index}`,
  );
  mapper.mapItems([]);
  return mapper;
}

async function readClaimStatus(
  ctx: EvalContext,
  claimId: TypeId<"claim">,
): Promise<string | null> {
  const [row] = await ctx.db
    .select({ status: claims.status })
    .from(claims)
    .where(eq(claims.id, claimId));
  return row?.status ?? null;
}

export const story13CleanupOpSubgraphBounding: EvalFixture = {
  name: "13-cleanup-op-subgraph-bounding",
  description:
    "applyCleanupOperations rejects retract/contradict/promote ops whose claim ids fall outside the rendered subgraph; in-bounds ops succeed.",
  setup: async (ctx) => {
    await seedNode(ctx, { name: "nodeA", type: "Concept", label: "Node A" });
    await seedNode(ctx, { name: "nodeB", type: "Concept", label: "Node B" });
    await seedSource(ctx, { name: "src", type: "conversation" });

    // Cα — in-subgraph claim, used as the citation in `contradict_claim`
    // (so the rejection is unambiguously about Cβ being out-of-subgraph,
    // not about a missing citation).
    await seedClaim(ctx, {
      name: "alpha",
      subjectName: "nodeA",
      predicate: "HAS_STATUS",
      objectValue: "alpha_status",
      sourceName: "src",
      assertedByKind: "user",
      statement: "Node A status is alpha.",
    });

    // Cβ — out-of-subgraph target. Seeded as `assistant_inferred` so the
    // positive `promote_assertion` would otherwise succeed if the guard
    // were absent (proving the rejection is from the guard, not from
    // `promoteAssertion`'s eligibility check).
    await seedClaim(ctx, {
      name: "beta",
      subjectName: "nodeB",
      predicate: "HAS_PREFERENCE",
      objectValue: "tea",
      sourceName: "src",
      assertedByKind: "assistant_inferred",
      statement: "Assistant inferred Node B prefers tea.",
    });
  },
  steps: [],
  expectations: {
    custom: [
      {
        description:
          "retract_claim referencing Cβ with allowedClaimIds={Cα} is rejected and Cβ remains active",
        run: async (ctx) => {
          const alphaId = ctx.claims.get("alpha")!;
          const betaId = ctx.claims.get("beta")!;
          const ops: CleanupOperation[] = [
            { kind: "retract_claim", claimId: betaId, reason: "test" },
          ];
          const result = await applyCleanupOperations(
            ctx.db,
            ctx.userId,
            ops,
            buildMapper(),
            new Set([alphaId]),
          );
          if (result.applied !== 0) {
            return {
              pass: false,
              message: `retract_claim applied=${result.applied}, expected 0`,
            };
          }
          const matchingError = result.errors.find(
            (e) =>
              e.kind === "retract_claim" &&
              e.message.includes("outside the rendered subgraph"),
          );
          if (!matchingError) {
            return {
              pass: false,
              message: `retract_claim no out-of-subgraph error; got ${JSON.stringify(result.errors)}`,
            };
          }
          const status = await readClaimStatus(ctx, betaId);
          if (status !== "active") {
            return {
              pass: false,
              message: `Cβ.status=${status} after rejected retract; expected unchanged 'active'`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "contradict_claim referencing Cβ with allowedClaimIds={Cα} is rejected and Cβ remains active",
        run: async (ctx) => {
          const alphaId = ctx.claims.get("alpha")!;
          const betaId = ctx.claims.get("beta")!;
          const ops: CleanupOperation[] = [
            {
              kind: "contradict_claim",
              claimId: betaId,
              contradictedByClaimId: alphaId,
              reason: "test",
            },
          ];
          const result = await applyCleanupOperations(
            ctx.db,
            ctx.userId,
            ops,
            buildMapper(),
            new Set([alphaId]),
          );
          if (result.applied !== 0) {
            return {
              pass: false,
              message: `contradict_claim applied=${result.applied}, expected 0`,
            };
          }
          const matchingError = result.errors.find(
            (e) =>
              e.kind === "contradict_claim" &&
              e.message.includes("outside the rendered subgraph"),
          );
          if (!matchingError) {
            return {
              pass: false,
              message: `contradict_claim no out-of-subgraph error; got ${JSON.stringify(result.errors)}`,
            };
          }
          const status = await readClaimStatus(ctx, betaId);
          if (status !== "active") {
            return {
              pass: false,
              message: `Cβ.status=${status} after rejected contradict; expected unchanged 'active'`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "promote_assertion referencing Cβ with allowedClaimIds={Cα} is rejected and Cβ remains active",
        run: async (ctx) => {
          const alphaId = ctx.claims.get("alpha")!;
          const betaId = ctx.claims.get("beta")!;
          // The corroboratingSourceId would be looked up by `promoteAssertion`
          // if the guard let the op through — but the guard rejects first, so
          // we never reach `promoteAssertion`. Use the seeded source id for
          // realism; the rejection still fires before the source lookup.
          const corroboratingSourceId = ctx.sources.get("src")!;
          const ops: CleanupOperation[] = [
            {
              kind: "promote_assertion",
              claimId: betaId,
              corroboratingSourceId,
              reason: "test",
            },
          ];
          const result = await applyCleanupOperations(
            ctx.db,
            ctx.userId,
            ops,
            buildMapper(),
            new Set([alphaId]),
          );
          if (result.applied !== 0) {
            return {
              pass: false,
              message: `promote_assertion applied=${result.applied}, expected 0`,
            };
          }
          const matchingError = result.errors.find(
            (e) =>
              e.kind === "promote_assertion" &&
              e.message.includes("outside the rendered subgraph"),
          );
          if (!matchingError) {
            return {
              pass: false,
              message: `promote_assertion no out-of-subgraph error; got ${JSON.stringify(result.errors)}`,
            };
          }
          const status = await readClaimStatus(ctx, betaId);
          if (status !== "active") {
            return {
              pass: false,
              message: `Cβ.status=${status} after rejected promote; expected unchanged 'active'`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "positive case: retract_claim with allowedClaimIds={Cβ} flips Cβ.status to 'retracted'",
        run: async (ctx) => {
          const betaId = ctx.claims.get("beta")!;
          // Sanity: must still be active before this assertion runs
          // (the prior negative cases must not have mutated it).
          const beforeStatus = await readClaimStatus(ctx, betaId);
          if (beforeStatus !== "active") {
            return {
              pass: false,
              message: `Cβ.status=${beforeStatus} before positive retract; expected active`,
            };
          }
          const ops: CleanupOperation[] = [
            {
              kind: "retract_claim",
              claimId: betaId,
              reason: "in-bounds retract",
            },
          ];
          const result = await applyCleanupOperations(
            ctx.db,
            ctx.userId,
            ops,
            buildMapper(),
            new Set([betaId]),
          );
          if (result.applied !== 1) {
            return {
              pass: false,
              message: `applied=${result.applied}, expected 1; errors=${JSON.stringify(result.errors)}`,
            };
          }
          const status = await readClaimStatus(ctx, betaId);
          if (status !== "retracted") {
            return {
              pass: false,
              message: `Cβ.status=${status} after positive retract; expected 'retracted'`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
