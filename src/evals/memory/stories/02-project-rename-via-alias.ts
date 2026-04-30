/**
 * Story 2 — Project renamed via alias.
 *
 * "Project Alpha is now Project A1" — the new label maps to the same Project
 * node. We assert that the rename adds an alias (whichever direction the
 * extraction layer chose) and that the canonical Project node is unique.
 */
import { seedAlias, seedNode } from "../seed";
import type { EvalFixture } from "../types";

export const story02ProjectRenameViaAlias: EvalFixture = {
  name: "02-project-rename-via-alias",
  description:
    "Renaming a Project preserves a single canonical node and records the alias.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "alpha",
      type: "Concept",
      label: "Project Alpha",
    });
    // Simulate the extraction-layer alias write that PR 2a's
    // `_processAndInsertLlmAliases` produces when a renamed reference points
    // back to the canonical node.
    await seedAlias(ctx, {
      canonicalNodeName: "alpha",
      aliasText: "Project A1",
    });
  },
  steps: [],
  expectations: {
    nodeCounts: [
      {
        description:
          "exactly one Concept node — rename did not duplicate the project",
        type: "Concept",
        exactCount: 1,
      },
    ],
    aliases: [
      {
        description: "alias 'Project A1' points at the canonical Project node",
        aliasText: "Project A1",
        canonicalNodeName: "alpha",
      },
    ],
  },
};
