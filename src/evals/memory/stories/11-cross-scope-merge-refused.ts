/**
 * Story 11 — Cross-scope merge refused.
 *
 * Attempt to merge a personal Person and a reference Person via the cleanup
 * `merge_nodes` operation. The dispatcher catches `CrossScopeMergeError`,
 * records the error, and leaves all rows untouched.
 */
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { eq } from "drizzle-orm";
import { nodes } from "~/db/schema";

export const story11CrossScopeMergeRefused: EvalFixture = {
  name: "11-cross-scope-merge-refused",
  description:
    "Cross-scope merge attempts throw CrossScopeMergeError and leave the graph unchanged.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "personalPerson",
      type: "Person",
      label: "Marie",
    });
    await seedNode(ctx, {
      name: "referencePerson",
      type: "Person",
      label: "Marie Curie",
    });
    await seedSource(ctx, { name: "personalSrc", type: "conversation" });
    await seedSource(ctx, {
      name: "referenceSrc",
      type: "document",
      scope: "reference",
    });
    await seedClaim(ctx, {
      name: "personalAnchor",
      subjectName: "personalPerson",
      predicate: "HAS_PREFERENCE",
      objectValue: "tea",
      sourceName: "personalSrc",
      scope: "personal",
      assertedByKind: "user",
    });
    await seedClaim(ctx, {
      name: "referenceAnchor",
      subjectName: "referencePerson",
      predicate: "MADE_DECISION",
      objectValue: "discovered radium",
      sourceName: "referenceSrc",
      scope: "reference",
      assertedByKind: "document_author",
    });
  },
  steps: [
    {
      kind: "applyCleanupOperations",
      operations: () => [
        {
          kind: "merge_nodes",
          keepTempId: "temp_node_0",
          removeTempIds: ["temp_node_1"],
        },
      ],
      seedNodeIds: (ctx) => [
        ctx.nodes.get("personalPerson")!,
        ctx.nodes.get("referencePerson")!,
      ],
    },
  ],
  expectations: {
    nodeCounts: [
      {
        description:
          "both Person nodes still exist after the refused cross-scope merge",
        type: "Person",
        exactCount: 2,
      },
    ],
    custom: [
      {
        description: "neither node was deleted; both still owned by the user",
        run: async (ctx) => {
          for (const name of ["personalPerson", "referencePerson"] as const) {
            const id = ctx.nodes.get(name);
            if (!id) return { pass: false, message: `missing ${name}` };
            const [row] = await ctx.db
              .select({ id: nodes.id })
              .from(nodes)
              .where(eq(nodes.id, id));
            if (!row) {
              return {
                pass: false,
                message: `node ${name} (${id}) was deleted`,
              };
            }
          }
          return { pass: true };
        },
      },
    ],
  },
};
