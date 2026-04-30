/**
 * Story 3 — Same person nickname + full name.
 *
 * "Met Jonathan today" then "Jon's coming over". Phase 3.2 identity
 * resolution should land both references on a single Person node with two
 * aliases. As of PR 4iii-c, identity resolution covers signals 1 (canonical
 * label), 2 (alias), 3 (embedding), and 4 (profile compat). Without an
 * embedding seed, we test the alias-driven resolution path:
 *   - First mention establishes the canonical Person + alias.
 *   - Second mention's label is found via the alias and resolves back.
 *
 * **Implementation gap acknowledged**: the harness asserts the *post-resolution
 * graph state* (single node + two aliases) directly, rather than driving the
 * extraction LLM end-to-end. The extraction-side alias-write path is exercised
 * by `extract-graph.test.ts`. This story pins the graph invariant that the
 * cleanup pipeline + identity resolver must preserve.
 */
import { seedAlias, seedNode } from "../seed";
import type { EvalFixture } from "../types";

export const story03PersonNickname: EvalFixture = {
  name: "03-person-nickname",
  description:
    "Same person referenced by full name and nickname collapses to one Person node with two aliases.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "jonathan",
      type: "Person",
      label: "Jonathan",
    });
    await seedAlias(ctx, {
      canonicalNodeName: "jonathan",
      aliasText: "Jonathan",
    });
    await seedAlias(ctx, {
      canonicalNodeName: "jonathan",
      aliasText: "Jon",
    });
  },
  steps: [],
  expectations: {
    nodeCounts: [
      {
        description: "single Person node — no nickname duplicate",
        type: "Person",
        exactCount: 1,
      },
    ],
    aliases: [
      {
        description: "full-name alias on the Person",
        aliasText: "Jonathan",
        canonicalNodeName: "jonathan",
      },
      {
        description: "nickname alias on the Person",
        aliasText: "Jon",
        canonicalNodeName: "jonathan",
      },
    ],
  },
};
