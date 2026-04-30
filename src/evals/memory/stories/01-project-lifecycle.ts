/**
 * Story 1 — Project starts, then completes; HAS_STATUS supersedes.
 *
 * Seeds a Project node + two `HAS_STATUS` claims (`in_progress` then `done`)
 * via direct DB writes, runs the registry-driven lifecycle engine, and
 * asserts the in-progress claim was superseded with `validTo` set to the
 * `done` claim's `statedAt`.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story01ProjectLifecycle: EvalFixture = {
  name: "01-project-lifecycle",
  description:
    "HAS_STATUS supersession: project starts in_progress then completes; prior claim moves to superseded with validTo set.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "alpha",
      type: "Concept",
      label: "Project Alpha",
    });
    await seedSource(ctx, { name: "convA", type: "conversation" });
    await seedSource(ctx, { name: "convB", type: "conversation" });
    await seedClaim(ctx, {
      name: "started",
      subjectName: "alpha",
      predicate: "HAS_STATUS",
      objectValue: "in_progress",
      sourceName: "convA",
      statement: "Marcel started Project Alpha.",
      statedAt: new Date("2026-04-20T09:00:00Z"),
    });
    await seedClaim(ctx, {
      name: "finished",
      subjectName: "alpha",
      predicate: "HAS_STATUS",
      objectValue: "done",
      sourceName: "convB",
      statement: "Marcel finished Project Alpha.",
      statedAt: new Date("2026-04-29T17:00:00Z"),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        await applyLifecycleByName(ctx, ["started", "finished"]);
      },
    },
  ],
  expectations: {
    claimCounts: [
      {
        description: "exactly one active HAS_STATUS claim survives",
        predicate: "HAS_STATUS",
        status: "active",
        exactCount: 1,
      },
      {
        description: "the prior in_progress claim is superseded",
        predicate: "HAS_STATUS",
        status: "superseded",
        exactCount: 1,
      },
    ],
    custom: [
      {
        description:
          "superseded claim has supersededByClaimId pointing at the done claim and validTo equal to its statedAt",
        run: async (ctx) => {
          const startedId = ctx.claims.get("started")!;
          const finishedId = ctx.claims.get("finished")!;
          const [started] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, startedId));
          const [finished] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, finishedId));
          if (!started || !finished) {
            return { pass: false, message: "claims missing post-lifecycle" };
          }
          if (started.status !== "superseded") {
            return {
              pass: false,
              message: `started.status=${started.status}, expected superseded`,
            };
          }
          if (started.supersededByClaimId !== finished.id) {
            return {
              pass: false,
              message: `started.supersededByClaimId=${started.supersededByClaimId}, expected ${finished.id}`,
            };
          }
          if (
            !started.validTo ||
            started.validTo.getTime() !== finished.statedAt.getTime()
          ) {
            return {
              pass: false,
              message: `started.validTo=${started.validTo?.toISOString()} != finished.statedAt=${finished.statedAt.toISOString()}`,
            };
          }
          if (finished.status !== "active") {
            return {
              pass: false,
              message: `finished.status=${finished.status}, expected active`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
