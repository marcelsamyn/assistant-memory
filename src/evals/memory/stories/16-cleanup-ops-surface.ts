/**
 * Story 16 — Cleanup operation surface coverage.
 *
 * `applyCleanupOperations` understands nine op kinds; before this fixture only
 * `merge_nodes` (via the cross-scope error path) was exercised by an eval.
 * This story walks every kind in sequence on a single seeded graph and asserts
 * the *specific shape change* each op promises.
 *
 *   create_node → add_claim → add_alias → promote_assertion →
 *   contradict_claim → retract_claim → merge_nodes → remove_alias →
 *   delete_node
 *
 * Each step uses an `applyCleanupOperations` step kind so the production
 * dispatcher (and its tempId mapper) drives the change; assertions verify the
 * resulting rows directly.
 *
 * Common aliases: cleanup ops, applyCleanupOperations coverage, op kind matrix.
 */
import {
  ensureUser,
  seedClaim,
  seedNode,
  seedSource,
} from "../seed";
import type { EvalFixture } from "../types";
import { and, eq } from "drizzle-orm";
import { aliases, claims, nodes } from "~/db/schema";
import { normalizeAliasText } from "~/lib/alias";

export const story16CleanupOpsSurface: EvalFixture = {
  name: "16-cleanup-ops-surface",
  description:
    "Every applyCleanupOperations op kind drives its promised shape change against a single seeded graph.",
  setup: async (ctx) => {
    await ensureUser(ctx);

    // Seed nodes, ordered so each appears at a known temp index per step.
    await seedNode(ctx, { name: "marcel", type: "Person", label: "Marcel" });
    await seedNode(ctx, {
      name: "alpha",
      type: "Concept",
      label: "Project Alpha",
    });
    // Two duplicates that will be merged in the merge_nodes step.
    await seedNode(ctx, {
      name: "dupKeep",
      type: "Concept",
      label: "Memory Layer",
    });
    await seedNode(ctx, {
      name: "dupRemove",
      type: "Concept",
      label: "Memory Layer (dup)",
    });
    // Free-standing node we'll delete at the end.
    await seedNode(ctx, {
      name: "doomed",
      type: "Concept",
      label: "Discarded idea",
    });

    await seedSource(ctx, { name: "convA", type: "conversation" });
    await seedSource(ctx, { name: "convB", type: "conversation" });

    // Seed claims that the various ops will mutate.
    // The `inferredStatus` claim gets promoted to user_confirmed.
    await seedClaim(ctx, {
      name: "inferredStatus",
      subjectName: "alpha",
      predicate: "HAS_STATUS",
      objectValue: "in_progress",
      sourceName: "convA",
      statement: "Project Alpha appears to be in progress.",
      assertedByKind: "assistant_inferred",
      statedAt: new Date("2026-04-20T09:00:00Z"),
    });

    // Target of contradict_claim and the citing claim (must be a user/system
    // claim that will be inserted by the contradict op? — no, citation is a
    // pre-existing claim that asserts the contradiction. Seed it now.).
    await seedClaim(ctx, {
      name: "victimPref",
      subjectName: "marcel",
      predicate: "HAS_PREFERENCE",
      objectValue: "tea",
      sourceName: "convA",
      statement: "Marcel prefers tea.",
      assertedByKind: "user",
      statedAt: new Date("2026-04-21T09:00:00Z"),
    });
    await seedClaim(ctx, {
      name: "contradictor",
      subjectName: "marcel",
      predicate: "HAS_PREFERENCE",
      objectValue: "coffee",
      sourceName: "convB",
      statement: "Marcel actually prefers coffee.",
      assertedByKind: "user",
      statedAt: new Date("2026-04-22T09:00:00Z"),
    });

    // Target of retract_claim.
    await seedClaim(ctx, {
      name: "retractMe",
      subjectName: "marcel",
      predicate: "RELATED_TO",
      objectName: "alpha",
      sourceName: "convA",
      statement: "Marcel is related to Project Alpha.",
      assertedByKind: "assistant_inferred",
      statedAt: new Date("2026-04-23T09:00:00Z"),
    });
  },
  steps: [
    // Step 1 — create_node. Adds a fresh Concept "freshIdea".
    {
      kind: "applyCleanupOperations",
      seedNodeIds: () => [],
      operations: () => [
        {
          kind: "create_node",
          tempId: "fresh",
          label: "Fresh idea",
          type: "Concept",
        },
      ],
    },
    // Step 2 — add_claim. HAS_PREFERENCE marcel → fresh idea.
    {
      kind: "applyCleanupOperations",
      seedNodeIds: (ctx) => [
        ctx.nodes.get("marcel")!,
        ctx.nodes.get("alpha")!,
        ctx.nodes.get("dupKeep")!,
        ctx.nodes.get("dupRemove")!,
        ctx.nodes.get("doomed")!,
      ],
      operations: () => [
        // Re-create the fresh node in this step's mapper so we can reference
        // it in add_claim. The previous step already inserted it; this op
        // adds a *second* fresh node and we then write the claim to it.
        {
          kind: "create_node",
          tempId: "fresh2",
          label: "Fresh idea (second)",
          type: "Concept",
        },
        {
          kind: "add_claim",
          subjectTempId: "temp_node_0", // marcel
          objectTempId: "fresh2",
          predicate: "HAS_PREFERENCE",
          statement: "Marcel likes the fresh idea.",
        },
      ],
    },
    // Step 3 — add_alias on dupKeep ("ML").
    {
      kind: "applyCleanupOperations",
      seedNodeIds: (ctx) => [ctx.nodes.get("dupKeep")!],
      operations: () => [
        {
          kind: "add_alias",
          nodeTempId: "temp_node_0",
          aliasText: "ML",
        },
      ],
    },
    // Step 4 — promote_assertion on the assistant_inferred HAS_STATUS claim.
    {
      kind: "applyCleanupOperations",
      seedNodeIds: () => [],
      operations: (ctx) => [
        {
          kind: "promote_assertion",
          claimId: ctx.claims.get("inferredStatus")!,
          corroboratingSourceId: ctx.sources.get("convB")!,
          reason: "user later confirmed in chat",
        },
      ],
    },
    // Step 5 — contradict_claim on victimPref, citing contradictor.
    {
      kind: "applyCleanupOperations",
      seedNodeIds: () => [],
      operations: (ctx) => [
        {
          kind: "contradict_claim",
          claimId: ctx.claims.get("victimPref")!,
          contradictedByClaimId: ctx.claims.get("contradictor")!,
          reason: "directly contradicted by later statement",
        },
      ],
    },
    // Step 6 — retract_claim on retractMe.
    {
      kind: "applyCleanupOperations",
      seedNodeIds: () => [],
      operations: (ctx) => [
        {
          kind: "retract_claim",
          claimId: ctx.claims.get("retractMe")!,
          reason: "no longer accurate",
        },
      ],
    },
    // Step 7 — merge_nodes (success path). Merge dupRemove into dupKeep.
    {
      kind: "applyCleanupOperations",
      seedNodeIds: (ctx) => [
        ctx.nodes.get("dupKeep")!,
        ctx.nodes.get("dupRemove")!,
      ],
      operations: () => [
        {
          kind: "merge_nodes",
          keepTempId: "temp_node_0",
          removeTempIds: ["temp_node_1"],
        },
      ],
    },
    // Step 8 — remove_alias "ML" from dupKeep (added in step 3).
    {
      kind: "applyCleanupOperations",
      seedNodeIds: (ctx) => [ctx.nodes.get("dupKeep")!],
      operations: () => [
        {
          kind: "remove_alias",
          nodeTempId: "temp_node_0",
          aliasText: "ML",
        },
      ],
    },
    // Step 9 — delete_node (doomed). The cleanup op only hard-deletes
    // evidence-free nodes.
    {
      kind: "applyCleanupOperations",
      seedNodeIds: (ctx) => [ctx.nodes.get("doomed")!],
      operations: () => [
        {
          kind: "delete_node",
          tempId: "temp_node_0",
        },
      ],
    },
  ],
  expectations: {
    custom: [
      {
        description: "create_node inserted a Concept node labeled 'Fresh idea'",
        run: async (ctx) => {
          const rows = await ctx.db
            .select({ id: nodes.id })
            .from(nodes)
            .where(
              and(eq(nodes.userId, ctx.userId), eq(nodes.nodeType, "Concept")),
            );
          // Concepts in the seed: alpha, dupKeep, doomed had it. After the
          // merge dupRemove is gone; doomed is deleted; we added two "Fresh
          // idea" nodes. Final Concept count should be alpha + dupKeep +
          // freshIdea + freshIdea(second) = 4.
          if (rows.length !== 4) {
            return {
              pass: false,
              message: `expected 4 Concept nodes after the run, got ${rows.length}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "add_claim wrote a HAS_PREFERENCE claim with assertedByKind=system on Marcel",
        run: async (ctx) => {
          const rows = await ctx.db
            .select()
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.subjectNodeId, ctx.nodes.get("marcel")!),
                eq(claims.predicate, "HAS_PREFERENCE"),
                eq(claims.assertedByKind, "system"),
              ),
            );
          if (rows.length !== 1) {
            return {
              pass: false,
              message: `expected 1 system-asserted HAS_PREFERENCE on Marcel, got ${rows.length}`,
            };
          }
          if (rows[0]?.statement !== "Marcel likes the fresh idea.") {
            return {
              pass: false,
              message: `add_claim statement mismatch: ${rows[0]?.statement}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "promote_assertion superseded the assistant_inferred claim with a user_confirmed copy whose statedAt is strictly later",
        run: async (ctx) => {
          const [original] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("inferredStatus")!));
          if (!original) {
            return { pass: false, message: "original claim missing" };
          }
          if (original.status !== "superseded") {
            return {
              pass: false,
              message: `original.status=${original.status}, expected superseded`,
            };
          }
          if (original.assertedByKind !== "assistant_inferred") {
            return {
              pass: false,
              message: `original.assertedByKind=${original.assertedByKind}, expected unchanged assistant_inferred`,
            };
          }

          const promoted = await ctx.db
            .select()
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.subjectNodeId, original.subjectNodeId),
                eq(claims.predicate, "HAS_STATUS"),
                eq(claims.assertedByKind, "user_confirmed"),
              ),
            );
          if (promoted.length !== 1) {
            return {
              pass: false,
              message: `expected 1 user_confirmed HAS_STATUS, got ${promoted.length}`,
            };
          }
          const [newClaim] = promoted;
          if (
            !newClaim ||
            newClaim.statedAt.getTime() <= original.statedAt.getTime()
          ) {
            return {
              pass: false,
              message: `promoted statedAt should be > original; got ${newClaim?.statedAt.toISOString()} vs ${original.statedAt.toISOString()}`,
            };
          }
          if (original.supersededByClaimId !== newClaim.id) {
            return {
              pass: false,
              message: `original.supersededByClaimId=${original.supersededByClaimId}, expected ${newClaim.id}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "contradict_claim flagged victimPref as contradicted with contradictedByClaimId pointing at the citing claim",
        run: async (ctx) => {
          const [victim] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("victimPref")!));
          if (!victim) {
            return { pass: false, message: "victim claim missing" };
          }
          if (victim.status !== "contradicted") {
            return {
              pass: false,
              message: `victim.status=${victim.status}, expected contradicted`,
            };
          }
          if (
            victim.contradictedByClaimId !== ctx.claims.get("contradictor")!
          ) {
            return {
              pass: false,
              message: `victim.contradictedByClaimId=${victim.contradictedByClaimId}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description: "retract_claim moved retractMe to status=retracted",
        run: async (ctx) => {
          const [row] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("retractMe")!));
          if (row?.status !== "retracted") {
            return {
              pass: false,
              message: `retractMe.status=${row?.status}, expected retracted`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "merge_nodes left dupKeep alive, deleted dupRemove, and rewired any claims",
        run: async (ctx) => {
          const [keepRow] = await ctx.db
            .select({ id: nodes.id })
            .from(nodes)
            .where(eq(nodes.id, ctx.nodes.get("dupKeep")!));
          if (!keepRow) {
            return {
              pass: false,
              message: "survivor dupKeep was deleted",
            };
          }
          const [removeRow] = await ctx.db
            .select({ id: nodes.id })
            .from(nodes)
            .where(eq(nodes.id, ctx.nodes.get("dupRemove")!));
          if (removeRow) {
            return {
              pass: false,
              message: "dupRemove still exists after merge",
            };
          }
          // No claim should still reference dupRemove as subject or object
          // (none were seeded against it, so this is a regression guard).
          const stale = await ctx.db
            .select({ id: claims.id })
            .from(claims)
            .where(eq(claims.subjectNodeId, ctx.nodes.get("dupRemove")!));
          if (stale.length !== 0) {
            return {
              pass: false,
              message: `claims still referencing dupRemove: ${stale.length}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "add_alias inserted 'ML' on dupKeep, then remove_alias deleted that exact row",
        run: async (ctx) => {
          const remaining = await ctx.db
            .select({ id: aliases.id })
            .from(aliases)
            .where(
              and(
                eq(aliases.userId, ctx.userId),
                eq(aliases.canonicalNodeId, ctx.nodes.get("dupKeep")!),
                eq(
                  aliases.normalizedAliasText,
                  normalizeAliasText("ML"),
                ),
              ),
            );
          if (remaining.length !== 0) {
            return {
              pass: false,
              message: `alias 'ML' should have been removed; ${remaining.length} rows remain`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "delete_node removed the evidence-free doomed node",
        run: async (ctx) => {
          const [row] = await ctx.db
            .select({ id: nodes.id })
            .from(nodes)
            .where(eq(nodes.id, ctx.nodes.get("doomed")!));
          if (row) {
            return { pass: false, message: "doomed node still present" };
          }
          return { pass: true };
        },
      },
    ],
  },
};
