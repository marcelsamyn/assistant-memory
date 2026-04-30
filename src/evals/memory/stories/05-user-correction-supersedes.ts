/**
 * Story 5 — User correction supersedes.
 *
 * "I work at Acme" then "Actually I work at Bravo". Both claims are
 * `HAS_STATUS` (single-current-value) on the user node; the second supersedes
 * the first via the registry-driven lifecycle engine.
 */
import { applyLifecycleByName } from "../runIngestionEval";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";

export const story05UserCorrectionSupersedes: EvalFixture = {
  name: "05-user-correction-supersedes",
  description:
    "User corrects a previously-stated status; the prior claim is superseded.",
  setup: async (ctx) => {
    await seedNode(ctx, { name: "user", type: "Person", label: "Marcel" });
    await seedSource(ctx, { name: "conv1", type: "conversation" });
    await seedSource(ctx, { name: "conv2", type: "conversation" });
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
  },
  steps: [
    {
      kind: "setup",
      run: async (ctx) => {
        await applyLifecycleByName(ctx, ["acme", "bravo"]);
      },
    },
  ],
  expectations: {
    claimCounts: [
      {
        description: "exactly one HAS_STATUS active after correction",
        predicate: "HAS_STATUS",
        status: "active",
        exactCount: 1,
      },
      {
        description: "Acme claim is superseded",
        predicate: "HAS_STATUS",
        status: "superseded",
        exactCount: 1,
      },
    ],
  },
};
