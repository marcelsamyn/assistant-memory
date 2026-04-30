/**
 * Story 7 — Pending task across sessions (HAS_TASK_STATUS lifecycle e2e).
 *
 * Session 1: a Task is created with `HAS_TASK_STATUS=pending` →
 * `getOpenCommitments` lists it.
 * Session 2: user says "I sent the spec" → `HAS_TASK_STATUS=done` supersedes
 * the pending claim. `getOpenCommitments` no longer lists it;
 * `supersededByClaimId` is set on the prior claim.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story07PendingTaskAcrossSessions: EvalFixture = {
  name: "07-pending-task-across-sessions",
  description:
    "Task lifecycle end-to-end: pending → done; getOpenCommitments reflects each transition; supersededByClaimId set.",
  setup: async (ctx) => {
    await seedNode(ctx, { name: "task", type: "Task", label: "Send spec" });
    await seedSource(ctx, { name: "session1", type: "conversation" });
    await seedSource(ctx, { name: "session2", type: "conversation" });
    await seedClaim(ctx, {
      name: "pending",
      subjectName: "task",
      predicate: "HAS_TASK_STATUS",
      objectValue: "pending",
      sourceName: "session1",
      statement: "Marcel committed to send the spec.",
      statedAt: new Date("2026-04-20T09:00:00Z"),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        // Session 1: lifecycle on the pending claim.
        await applyLifecycleByName(ctx, ["pending"]);

        // Verify session-1 state before session 2 lands. We do this inline so
        // a subsequent step can assert "no longer in commitments".
        const { getOpenCommitments } = await import(
          "~/lib/query/open-commitments"
        );
        const before = await getOpenCommitments({ userId: ctx.userId });
        if (before.length !== 1) {
          throw new Error(
            `session-1 expected 1 open commitment, got ${before.length}`,
          );
        }
        if (before[0]?.taskId !== ctx.nodes.get("task")) {
          throw new Error("session-1 commitment did not point at the task");
        }

        // Session 2: same task, status=done, supersedes.
        await seedClaim(ctx, {
          name: "done",
          subjectName: "task",
          predicate: "HAS_TASK_STATUS",
          objectValue: "done",
          sourceName: "session2",
          statement: "Marcel sent the spec.",
          statedAt: new Date("2026-04-29T15:00:00Z"),
        });
        await applyLifecycleByName(ctx, ["pending", "done"]);
      },
    },
  ],
  expectations: {
    claimCounts: [
      {
        description: "one active HAS_TASK_STATUS (the done claim)",
        predicate: "HAS_TASK_STATUS",
        status: "active",
        exactCount: 1,
      },
      {
        description: "the pending claim is superseded",
        predicate: "HAS_TASK_STATUS",
        status: "superseded",
        exactCount: 1,
      },
    ],
    custom: [
      {
        description:
          "getOpenCommitments returns nothing after the task is marked done; pending claim has supersededByClaimId set",
        run: async (ctx) => {
          const { getOpenCommitments } = await import(
            "~/lib/query/open-commitments"
          );
          const after = await getOpenCommitments({ userId: ctx.userId });
          if (after.length !== 0) {
            return {
              pass: false,
              message: `getOpenCommitments returned ${after.length} after done; expected 0`,
            };
          }
          const [pending] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("pending")!));
          const [done] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("done")!));
          if (pending?.supersededByClaimId !== done?.id) {
            return {
              pass: false,
              message: `pending.supersededByClaimId=${pending?.supersededByClaimId}, expected ${done?.id}`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
