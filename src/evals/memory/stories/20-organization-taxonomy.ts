/**
 * Story 20 — Organization taxonomy.
 *
 * A canned extractor response uses Organization for a formal employer and a
 * named informal group, while leaving a product as Object. Valid organization
 * edges must survive extraction.
 *
 * Common aliases: organization node type eval, employer taxonomy regression, named group regression.
 */
import type { EvalFixture } from "../types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";

export const story20OrganizationTaxonomy: EvalFixture = {
  name: "20-organization-taxonomy",
  description:
    "Extraction accepts Organization nodes for employers and named groups without misclassifying products.",
  steps: [
    {
      kind: "ingestConversation",
      conversationId: "conv-organization-taxonomy",
      messages: [
        {
          id: "msg-organization-1",
          role: "user",
          content:
            "Ari works at Orchard Labs, founded Blue Harbor Studio, is part of Saturday Supper Club, and the studio owns Northstar Collective.",
          timestamp: new Date("2026-06-19T10:00:00Z"),
        },
      ],
      extractionStubs: [
        {
          nodes: [
            {
              id: "temp_person",
              type: "Person",
              label: "Ari",
              description: "Person mentioned in the source.",
            },
            {
              id: "temp_employer",
              type: "Organization",
              label: "Orchard Labs",
              description: "Ari's employer.",
            },
            {
              id: "temp_studio",
              type: "Organization",
              label: "Blue Harbor Studio",
              description: "Organization Ari founded.",
            },
            {
              id: "temp_group",
              type: "Organization",
              label: "Saturday Supper Club",
              description: "Named informal group.",
            },
            {
              id: "temp_collective",
              type: "Organization",
              label: "Northstar Collective",
              description: "Organization owned by another organization.",
            },
            {
              id: "temp_product",
              type: "Object",
              label: "Northstar app",
              description: "Product, not the operating organization.",
            },
          ],
          relationshipClaims: [
            {
              subjectId: "temp_person",
              objectId: "temp_employer",
              predicate: "WORKS_AT",
              statement: "Ari works at Orchard Labs.",
              sourceRef: "msg-organization-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_person",
              objectId: "temp_studio",
              predicate: "FOUNDED",
              statement: "Ari founded Blue Harbor Studio.",
              sourceRef: "msg-organization-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_person",
              objectId: "temp_group",
              predicate: "AFFILIATED_WITH",
              statement: "Ari is affiliated with Saturday Supper Club.",
              sourceRef: "msg-organization-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_studio",
              objectId: "temp_collective",
              predicate: "OWNS",
              statement: "Blue Harbor Studio owns Northstar Collective.",
              sourceRef: "msg-organization-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_studio",
              objectId: "temp_product",
              predicate: "CREATED",
              statement: "Blue Harbor Studio created the Northstar app.",
              sourceRef: "msg-organization-1",
              assertionKind: "user",
            },
          ],
          attributeClaims: [],
        },
      ],
    },
  ],
  expectations: {
    nodeCounts: [
      {
        description: "organization nodes are minted for formal and informal groups",
        type: "Organization",
        exactCount: 4,
      },
      {
        description: "the product remains an object",
        type: "Object",
        exactCount: 1,
      },
    ],
    custom: [
      {
        description: "organization relationships survive shape validation",
        run: async (ctx) => {
          const [relationshipRows] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                inArray(claims.predicate, [
                  "AFFILIATED_WITH",
                  "CREATED",
                  "FOUNDED",
                  "OWNS",
                  "WORKS_AT",
                ]),
              ),
            );
          if ((relationshipRows?.count ?? 0) !== 5) {
            return {
              pass: false,
              message: `expected 5 active organization relationships, got ${relationshipRows?.count ?? 0}`,
            };
          }

          const [misclassifiedProductRows] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(nodes)
            .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
            .where(
              and(
                eq(nodes.userId, ctx.userId),
                eq(nodes.nodeType, "Organization"),
                eq(nodeMetadata.label, "Northstar app"),
              ),
            );
          if ((misclassifiedProductRows?.count ?? 0) !== 0) {
            return {
              pass: false,
              message: "expected Northstar app to remain Object, not Organization",
            };
          }

          return { pass: true };
        },
      },
    ],
  },
};
