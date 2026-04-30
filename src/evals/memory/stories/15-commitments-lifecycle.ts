/**
 * Story 15 — Open commitments lifecycle (`getOpenCommitments` read-model).
 *
 * The chat-assistant contract calls `getOpenCommitments` to answer "what's
 * pending?". This story pins three behaviors:
 *  1. HAS_TASK_STATUS lifecycle: pending → in_progress → done. Each
 *     transition should be a registry-driven supersession; once done the
 *     task disappears from the open list.
 *  2. `ownedBy` filter: returns only tasks whose active OWNED_BY claim points
 *     at the requested node id.
 *  3. `dueBefore` filter: drops tasks whose active DUE_ON falls outside the
 *     requested ceiling.
 *
 * Common aliases: open commitments, list_open_commitments, getOpenCommitments,
 * task lifecycle, pending tasks.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalContext, EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

async function loadOpenCommitments(ctx: EvalContext, params: {
  ownedBy?: TypeId<"node">;
  dueBefore?: string;
}) {
  const { getOpenCommitments } = await import("~/lib/query/open-commitments");
  return getOpenCommitments({
    userId: ctx.userId,
    ...(params.ownedBy !== undefined ? { ownedBy: params.ownedBy } : {}),
    ...(params.dueBefore !== undefined ? { dueBefore: params.dueBefore } : {}),
  });
}

export const story15CommitmentsLifecycle: EvalFixture = {
  name: "15-commitments-lifecycle",
  description:
    "HAS_TASK_STATUS pending→in_progress→done lifecycle plus ownedBy and dueBefore filters on getOpenCommitments.",
  setup: async (ctx) => {
    // Primary task driving the lifecycle progression.
    await seedNode(ctx, {
      name: "specTask",
      type: "Task",
      label: "Ship the spec",
    });

    // Filter fixtures.
    await seedNode(ctx, { name: "bob", type: "Person", label: "Bob" });
    await seedNode(ctx, {
      name: "bobTask",
      type: "Task",
      label: "Bob's report",
    });
    await seedNode(ctx, {
      name: "futureTask",
      type: "Task",
      label: "Plan offsite",
    });
    // DUE_ON object node — Temporal node whose label is the due-date string.
    await seedNode(ctx, {
      name: "due20260515",
      type: "Temporal",
      label: "2026-05-15",
    });

    await seedSource(ctx, { name: "sessionPending", type: "conversation" });
    await seedSource(ctx, { name: "sessionInProgress", type: "conversation" });
    await seedSource(ctx, { name: "sessionDone", type: "conversation" });
    await seedSource(ctx, { name: "sessionFilters", type: "conversation" });
  },
  steps: [
    // Phase 1 — pending claim only; expect 1 open commitment.
    {
      kind: "setup",
      run: async (ctx) => {
        await seedClaim(ctx, {
          name: "pending",
          subjectName: "specTask",
          predicate: "HAS_TASK_STATUS",
          objectValue: "pending",
          sourceName: "sessionPending",
          statement: "Marcel committed to shipping the spec.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-25T09:00:00Z"),
        });
        await applyLifecycleByName(ctx, ["pending"]);

        const open = await loadOpenCommitments(ctx, {});
        if (open.length !== 1) {
          throw new Error(
            `phase1: expected 1 open commitment, got ${open.length}`,
          );
        }
        if (open[0]?.status !== "pending") {
          throw new Error(
            `phase1: expected status=pending, got ${open[0]?.status}`,
          );
        }
      },
    },
    // Phase 2 — in_progress supersedes pending; still 1 open commitment.
    {
      kind: "setup",
      run: async (ctx) => {
        await seedClaim(ctx, {
          name: "inProgress",
          subjectName: "specTask",
          predicate: "HAS_TASK_STATUS",
          objectValue: "in_progress",
          sourceName: "sessionInProgress",
          statement: "Marcel started writing the spec.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T09:00:00Z"),
        });
        await applyLifecycleByName(ctx, ["pending", "inProgress"]);

        const open = await loadOpenCommitments(ctx, {});
        if (open.length !== 1) {
          throw new Error(
            `phase2: expected 1 open commitment, got ${open.length}`,
          );
        }
        if (open[0]?.status !== "in_progress") {
          throw new Error(
            `phase2: expected status=in_progress, got ${open[0]?.status}`,
          );
        }

        // Prior pending claim should now be superseded.
        const [prior] = await ctx.db
          .select()
          .from(claims)
          .where(eq(claims.id, ctx.claims.get("pending")!));
        if (prior?.status !== "superseded") {
          throw new Error(
            `phase2: pending.status=${prior?.status}, expected superseded`,
          );
        }
      },
    },
    // Phase 3 — seed filter fixtures alongside main task before "done".
    // Bob's task (different owner, pending) and the future-due task share the
    // same lifecycle replay so they appear as open commitments alongside
    // specTask before the done transition.
    {
      kind: "setup",
      run: async (ctx) => {
        await seedClaim(ctx, {
          name: "bobPending",
          subjectName: "bobTask",
          predicate: "HAS_TASK_STATUS",
          objectValue: "pending",
          sourceName: "sessionFilters",
          statement: "Bob owes a report.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T10:00:00Z"),
        });
        await seedClaim(ctx, {
          name: "bobOwned",
          subjectName: "bobTask",
          objectName: "bob",
          predicate: "OWNED_BY",
          sourceName: "sessionFilters",
          statement: "Bob owns the report.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T10:00:00Z"),
        });
        await seedClaim(ctx, {
          name: "futurePending",
          subjectName: "futureTask",
          predicate: "HAS_TASK_STATUS",
          objectValue: "pending",
          sourceName: "sessionFilters",
          statement: "Plan offsite is pending.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T10:00:00Z"),
        });
        await seedClaim(ctx, {
          name: "futureDue",
          subjectName: "futureTask",
          objectName: "due20260515",
          predicate: "DUE_ON",
          sourceName: "sessionFilters",
          statement: "Plan offsite is due on 2026-05-15.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-26T10:00:00Z"),
        });
        await applyLifecycleByName(ctx, [
          "bobPending",
          "bobOwned",
          "futurePending",
          "futureDue",
        ]);
      },
    },
    // Phase 4 — done supersedes in_progress on the primary task.
    {
      kind: "setup",
      run: async (ctx) => {
        await seedClaim(ctx, {
          name: "done",
          subjectName: "specTask",
          predicate: "HAS_TASK_STATUS",
          objectValue: "done",
          sourceName: "sessionDone",
          statement: "Marcel shipped the spec.",
          assertedByKind: "user",
          statedAt: new Date("2026-04-29T17:00:00Z"),
        });
        await applyLifecycleByName(ctx, ["pending", "inProgress", "done"]);

        const [inProgress] = await ctx.db
          .select()
          .from(claims)
          .where(eq(claims.id, ctx.claims.get("inProgress")!));
        if (inProgress?.status !== "superseded") {
          throw new Error(
            `phase4: inProgress.status=${inProgress?.status}, expected superseded`,
          );
        }
      },
    },
  ],
  expectations: {
    custom: [
      {
        description:
          "after done transition, specTask is no longer in getOpenCommitments; bobTask and futureTask remain",
        run: async (ctx) => {
          const open = await loadOpenCommitments(ctx, {});
          const ids = open.map((c) => c.taskId);
          if (ids.includes(ctx.nodes.get("specTask")!)) {
            return {
              pass: false,
              message: `specTask still listed after done: ${ids.join(", ")}`,
            };
          }
          if (!ids.includes(ctx.nodes.get("bobTask")!)) {
            return { pass: false, message: "bobTask missing from open list" };
          }
          if (!ids.includes(ctx.nodes.get("futureTask")!)) {
            return {
              pass: false,
              message: "futureTask missing from open list",
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "ownedBy filter narrows to Bob's task only (rejects unowned and other-owner tasks)",
        run: async (ctx) => {
          const open = await loadOpenCommitments(ctx, {
            ownedBy: ctx.nodes.get("bob")!,
          });
          if (open.length !== 1) {
            return {
              pass: false,
              message: `ownedBy=bob expected 1 row, got ${open.length}`,
            };
          }
          if (open[0]?.taskId !== ctx.nodes.get("bobTask")!) {
            return {
              pass: false,
              message: `ownedBy=bob returned wrong task ${open[0]?.taskId}`,
            };
          }
          return { pass: true };
        },
      },
      {
        description:
          "dueBefore=2026-05-01 excludes the futureTask due 2026-05-15; dueBefore=2026-05-30 includes it",
        run: async (ctx) => {
          const tight = await loadOpenCommitments(ctx, {
            dueBefore: "2026-05-01",
          });
          const tightIds = tight.map((c) => c.taskId);
          if (tightIds.includes(ctx.nodes.get("futureTask")!)) {
            return {
              pass: false,
              message: `dueBefore=2026-05-01 should exclude futureTask but didn't`,
            };
          }
          const wide = await loadOpenCommitments(ctx, {
            dueBefore: "2026-05-30",
          });
          const wideIds = wide.map((c) => c.taskId);
          if (!wideIds.includes(ctx.nodes.get("futureTask")!)) {
            return {
              pass: false,
              message: `dueBefore=2026-05-30 should include futureTask but didn't`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
