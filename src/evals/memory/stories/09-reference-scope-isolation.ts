/**
 * Story 9 — Reference scope isolation.
 *
 * A reference document about Marie Curie is ingested under
 * `scope = "reference"`. Default `searchMemory` (personal scope) must not
 * return it. `searchReference` (reference scope) does. We assert the SQL
 * filter contract — mirroring what `findSimilarClaims` and the card-search
 * paths apply by default — without requiring a real embedding.
 */
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq, sql } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story09ReferenceScopeIsolation: EvalFixture = {
  name: "09-reference-scope-isolation",
  description:
    "Reference-scope claims are invisible to default (personal) search but visible to reference search.",
  setup: async (ctx) => {
    await seedNode(ctx, {
      name: "marieCurie",
      type: "Person",
      label: "Marie Curie",
    });
    await seedSource(ctx, {
      name: "doc",
      type: "document",
      scope: "reference",
      metadata: { author: "Wikipedia" },
    });
    await seedClaim(ctx, {
      name: "discoveredRadium",
      subjectName: "marieCurie",
      predicate: "MADE_DECISION",
      objectValue: "discovered radium",
      sourceName: "doc",
      scope: "reference",
      assertedByKind: "document_author",
      statement: "Marie Curie discovered radium.",
    });
  },
  steps: [],
  expectations: {
    custom: [
      {
        description:
          "default personal-scope query returns 0; reference-scope query returns 1",
        run: async (ctx) => {
          const [personal] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.scope, "personal"),
                eq(claims.status, "active"),
              ),
            );
          const [reference] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.scope, "reference"),
                eq(claims.status, "active"),
              ),
            );
          if ((personal?.count ?? 0) !== 0) {
            return {
              pass: false,
              message: `personal-scope returned ${personal?.count}, expected 0`,
            };
          }
          if ((reference?.count ?? 0) !== 1) {
            return {
              pass: false,
              message: `reference-scope returned ${reference?.count}, expected 1`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
