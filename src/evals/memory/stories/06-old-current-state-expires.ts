/**
 * Story 6 — Old current-state expires (validTo set on supersession).
 *
 * Same shape as story 1 but tightens the assertion: once a single-valued
 * claim is superseded, `validTo` MUST equal the supersedor's `statedAt`. This
 * is the behavior `applyClaimLifecycle` is contracted to provide.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story06OldCurrentStateExpires: EvalFixture = {
  name: "06-old-current-state-expires",
  description:
    "On supersession, the prior claim's validTo equals the new claim's statedAt.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "task",
      type: "Task",
      label: "Ship spec",
    });
    await seedSource(ctx, { name: "convA", type: "conversation" });
    await seedSource(ctx, { name: "convB", type: "conversation" });
    await seedClaim(ctx, {
      name: "pending",
      subjectName: "task",
      predicate: "HAS_TASK_STATUS",
      objectValue: "pending",
      sourceName: "convA",
      statedAt: new Date("2026-04-22T08:00:00Z"),
    });
    await seedClaim(ctx, {
      name: "done",
      subjectName: "task",
      predicate: "HAS_TASK_STATUS",
      objectValue: "done",
      sourceName: "convB",
      statedAt: new Date("2026-04-29T16:30:00Z"),
    });
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        await applyLifecycleByName(ctx, ["pending", "done"]);
      },
    },
  ],
  expectations: {
    custom: [
      {
        description:
          "validTo on the superseded claim equals statedAt on the active successor",
        run: async (ctx) => {
          const [pending] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("pending")!));
          const [done] = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("done")!));
          if (!pending || !done) {
            return { pass: false, message: "claims missing" };
          }
          if (pending.status !== "superseded") {
            return {
              pass: false,
              message: `pending.status=${pending.status}`,
            };
          }
          if (
            !pending.validTo ||
            pending.validTo.getTime() !== done.statedAt.getTime()
          ) {
            return {
              pass: false,
              message: `pending.validTo=${pending.validTo?.toISOString()} != done.statedAt=${done.statedAt.toISOString()}`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
