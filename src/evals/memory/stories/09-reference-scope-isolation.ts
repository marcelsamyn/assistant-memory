/**
 * Story 9 — Reference scope isolation.
 *
 * Drives the actual read-surface APIs (`searchMemory`, `searchReference`) to
 * verify that reference-scope content stays out of personal search and vice
 * versa. The assertion exercises both:
 *
 *   1. The SQL-level scope filter inside `findSimilarClaims` — a
 *      reference-scope claim must never surface in `searchMemory.evidence`,
 *      even when its subject node has personal support that would survive the
 *      card-level filter.
 *   2. The card-level `keepScope` post-filter inside `searchAsCards` — a
 *      personal-derived card must not surface in `searchReference.cards`,
 *      even when a personal claim happens to mention the query string.
 *
 * Embeddings are bypassed via the `semanticSearchSubstringQuery` test seam so
 * the harness does not need pgvector or Jina. The seam runs the same scope /
 * `assertedByKind` / status SQL guards as the production embedding path; the
 * only change is the row-match predicate (substring vs. cosine).
 */
import { searchMemory, searchReference } from "~/lib/context/search-cards";
import { setSemanticSearchSubstringQuery } from "~/utils/test-overrides";
import { seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";

export const story09ReferenceScopeIsolation: EvalFixture = {
  name: "09-reference-scope-isolation",
  description:
    "searchMemory hides reference-scope hits (SQL filter); searchReference hides personal-derived cards (card-level filter).",
  setup: async (ctx) => {
    // Mixed-support node: both personal and reference claims attach here. The
    // derived card scope resolves to "personal" (personal wins), so the
    // card-level filter alone cannot hide the reference claim — only the SQL
    // scope guard inside `findSimilarClaims` keeps it out of `searchMemory`.
    await seedNode(ctx, {
      name: "teaTopic",
      type: "Concept",
      label: "Tea preferences",
    });
    // Reference-only node — a separate Wikipedia-style document subject. Its
    // derived scope resolves to "reference" so `searchMemory`'s card filter
    // would drop it; `searchReference` needs it as the positive case.
    await seedNode(ctx, {
      name: "wikiTea",
      type: "Concept",
      label: "Tea (encyclopedia entry)",
    });

    await seedSource(ctx, { name: "convA", type: "conversation" });
    await seedSource(ctx, {
      name: "wikiDoc",
      type: "document",
      scope: "reference",
      metadata: { author: "Wikipedia", title: "Tea" },
    });

    await seedClaim(ctx, {
      name: "personalTea",
      subjectName: "teaTopic",
      predicate: "HAS_PREFERENCE",
      objectValue: "the user prefers tea",
      sourceName: "convA",
      scope: "personal",
      assertedByKind: "user",
      statement: "The user prefers tea over coffee.",
    });
    await seedClaim(ctx, {
      name: "referenceTea",
      subjectName: "teaTopic",
      predicate: "MADE_DECISION",
      objectValue: "tea is well-studied",
      sourceName: "wikiDoc",
      scope: "reference",
      assertedByKind: "document_author",
      statement: "The documentation says tea is well-studied.",
    });
    await seedClaim(ctx, {
      name: "wikiTeaFact",
      subjectName: "wikiTea",
      predicate: "MADE_DECISION",
      objectValue: "tea originated in China",
      sourceName: "wikiDoc",
      scope: "reference",
      assertedByKind: "document_author",
      statement: "Encyclopedia entry: tea originated in China.",
    });
  },
  steps: [],
  expectations: {
    custom: [
      {
        description:
          "searchMemory excludes reference-scope evidence (SQL filter) and reference-derived cards",
        run: async (ctx) => {
          setSemanticSearchSubstringQuery("tea");
          try {
            const result = await searchMemory({
              userId: ctx.userId,
              query: "tea",
            });

            const referenceClaimIds = new Set([
              ctx.claims.get("referenceTea"),
              ctx.claims.get("wikiTeaFact"),
            ]);
            const leakedEvidence = result.evidence.filter((e) =>
              referenceClaimIds.has(e.claimId),
            );
            if (leakedEvidence.length > 0) {
              return {
                pass: false,
                message: `searchMemory.evidence leaked reference claim ids: ${leakedEvidence
                  .map((e) => e.claimId)
                  .join(", ")}`,
              };
            }

            const wikiTeaId = ctx.nodes.get("wikiTea");
            const leakedCard = result.cards.find(
              (c) => c.nodeId === wikiTeaId,
            );
            if (leakedCard) {
              return {
                pass: false,
                message: `searchMemory.cards leaked reference-only node 'wikiTea' (scope=${leakedCard.scope})`,
              };
            }

            const teaTopicId = ctx.nodes.get("teaTopic");
            const teaTopicCard = result.cards.find(
              (c) => c.nodeId === teaTopicId,
            );
            if (!teaTopicCard) {
              return {
                pass: false,
                message:
                  "searchMemory.cards missing the personal-supported 'teaTopic' card",
              };
            }
            const personalClaimId = ctx.claims.get("personalTea");
            const sawPersonalEvidence = result.evidence.some(
              (e) => e.claimId === personalClaimId,
            );
            if (!sawPersonalEvidence) {
              return {
                pass: false,
                message:
                  "searchMemory.evidence missing the personal claim hit",
              };
            }
            return { pass: true };
          } finally {
            setSemanticSearchSubstringQuery(null);
          }
        },
      },
      {
        description:
          "searchReference excludes personal-derived cards (card-level filter) and personal evidence",
        run: async (ctx) => {
          setSemanticSearchSubstringQuery("tea");
          try {
            const result = await searchReference({
              userId: ctx.userId,
              query: "tea",
            });

            const teaTopicId = ctx.nodes.get("teaTopic");
            const personalCard = result.cards.find(
              (c) => c.nodeId === teaTopicId,
            );
            if (personalCard) {
              return {
                pass: false,
                message: `searchReference.cards leaked personal-derived node 'teaTopic' (scope=${personalCard.scope})`,
              };
            }

            const personalClaimId = ctx.claims.get("personalTea");
            const leakedEvidence = result.evidence.find(
              (e) => e.claimId === personalClaimId,
            );
            if (leakedEvidence) {
              return {
                pass: false,
                message: `searchReference.evidence leaked personal claim id ${leakedEvidence.claimId}`,
              };
            }

            const wikiTeaId = ctx.nodes.get("wikiTea");
            const wikiCard = result.cards.find((c) => c.nodeId === wikiTeaId);
            if (!wikiCard) {
              return {
                pass: false,
                message:
                  "searchReference.cards missing the reference-only 'wikiTea' card",
              };
            }
            if (wikiCard.scope !== "reference") {
              return {
                pass: false,
                message: `wikiTea card derived scope=${wikiCard.scope}; expected reference`,
              };
            }
            return { pass: true };
          } finally {
            setSemanticSearchSubstringQuery(null);
          }
        },
      },
    ],
  },
};
