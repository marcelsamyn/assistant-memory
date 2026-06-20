/**
 * Story 19 — Relationship predicate shape guardrails.
 *
 * A canned extractor response tries the generic bad-shape cases that prompted
 * the relation-taxonomy work: person-to-person deadline, person located in an
 * object, person exhibiting a non-emotion account/media node, reversed event
 * participants, reversed dates, content emotion, and reversed involved items.
 * The real ingestion path must drop those relationship claims while keeping
 * valid scalar preferences and an allowed RELATED_TO fallback.
 *
 * Common aliases: predicate shape eval, invalid edge guardrail, relation taxonomy regression.
 */
import type { EvalFixture } from "../types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { claims } from "~/db/schema";

export const story19PredicateShapeGuardrails: EvalFixture = {
  name: "19-predicate-shape-guardrails",
  description:
    "Extraction drops invalid relationship predicate shapes while preserving a valid scalar preference and RELATED_TO fallback.",
  steps: [
    {
      kind: "ingestConversation",
      conversationId: "conv-predicate-shape-guardrails",
      messages: [
        {
          id: "msg-predicate-shape-1",
          role: "user",
          content:
            "Ada thanked Lee, liked the ceramic mug, viewed a social account, and compared two products in an article.",
          timestamp: new Date("2026-06-18T09:00:00Z"),
        },
      ],
      extractionStubs: [
        {
          nodes: [
            {
              id: "temp_person",
              type: "Person",
              label: "Ada",
              description: "The user in this fixture.",
            },
            {
              id: "temp_friend",
              type: "Person",
              label: "Lee",
              description: "Person Ada thanked.",
            },
            {
              id: "temp_mug",
              type: "Object",
              label: "ceramic mug",
              description: "Object Ada likes.",
            },
            {
              id: "temp_account",
              type: "Media",
              label: "social account",
              description: "Viewed account.",
            },
            {
              id: "temp_article",
              type: "Media",
              label: "comparison article",
              description: "Article comparing products.",
            },
            {
              id: "temp_workshop",
              type: "Event",
              label: "planning workshop",
              description: "Event used for predicate direction checks.",
            },
            {
              id: "temp_day",
              type: "Temporal",
              label: "2026-06-18",
              description: "Date used for predicate direction checks.",
            },
            {
              id: "temp_tone",
              type: "Emotion",
              label: "urgency",
              description: "Tone conveyed by content, not a person emotion.",
            },
            {
              id: "temp_product",
              type: "Object",
              label: "reference product",
              description: "Product compared in the article.",
            },
          ],
          relationshipClaims: [
            {
              subjectId: "temp_person",
              objectId: "temp_friend",
              predicate: "DUE_ON",
              statement: "Ada thanked Lee.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_person",
              objectId: "temp_mug",
              predicate: "LOCATED_IN",
              statement: "Ada likes the ceramic mug.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_person",
              objectId: "temp_account",
              predicate: "EXHIBITED_EMOTION",
              statement: "Ada viewed the social account.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_workshop",
              objectId: "temp_person",
              predicate: "PARTICIPATED_IN",
              statement: "Ada participated in the planning workshop.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_day",
              objectId: "temp_workshop",
              predicate: "OCCURRED_ON",
              statement: "The planning workshop happened on 2026-06-18.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_article",
              objectId: "temp_tone",
              predicate: "EXHIBITED_EMOTION",
              statement: "The article conveys urgency.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_product",
              objectId: "temp_workshop",
              predicate: "INVOLVED_ITEM",
              statement: "The workshop involved the reference product.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
            {
              subjectId: "temp_article",
              objectId: "temp_product",
              predicate: "RELATED_TO",
              statement:
                "The comparison article explicitly references the product.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
          ],
          attributeClaims: [
            {
              subjectId: "temp_person",
              predicate: "HAS_PREFERENCE",
              objectValue: "likes ceramic mugs",
              statement: "Ada likes ceramic mugs.",
              sourceRef: "msg-predicate-shape-1",
              assertionKind: "user",
            },
          ],
        },
      ],
    },
  ],
  expectations: {
    custom: [
      {
        description:
          "bad relationship predicates are dropped while valid preference and RELATED_TO claims remain",
        run: async (ctx) => {
          const [badRows] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                inArray(claims.predicate, [
                  "DUE_ON",
                  "LOCATED_IN",
                  "EXHIBITED_EMOTION",
                  "PARTICIPATED_IN",
                  "OCCURRED_ON",
                  "INVOLVED_ITEM",
                ]),
              ),
            );
          if ((badRows?.count ?? 0) !== 0) {
            return {
              pass: false,
              message: `expected 0 active bad-shape claims, got ${badRows?.count ?? 0}`,
            };
          }

          const [goodRows] = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.status, "active"),
                inArray(claims.predicate, ["HAS_PREFERENCE", "RELATED_TO"]),
              ),
            );
          if ((goodRows?.count ?? 0) !== 2) {
            return {
              pass: false,
              message: `expected 2 active valid claims, got ${goodRows?.count ?? 0}`,
            };
          }

          return { pass: true };
        },
      },
    ],
  },
};
