/**
 * Story 10 — Multi-party transcript (speaker attribution).
 *
 * A three-speaker meeting driven through the real transcript ingestion
 * pipeline (`ingestTranscript` → `resolveSpeakers` → `extractGraph` with a
 * speakerMap):
 *   - Marcel (user-self via `userSelfAliases`): "I shipped the spec." →
 *     `assertedByKind = 'user'`, `assertedByNodeId = null`.
 *   - Bob (resolved via `knownParticipants`): "I'd prefer a tighter spec." →
 *     `assertedByKind = 'participant'`, `assertedByNodeId = bob`.
 *   - Stranger (unknown — placeholder Person minted by resolveSpeakers):
 *     "Let's ship by Friday." → participant claim attributed to the
 *     placeholder.
 *
 * Pins the contract that downstream consumers (open commitments, search
 * filters, atlas synthesis) depend on: user-self collapses, participant
 * provenance is preserved, placeholder Person nodes are flagged.
 */
import { seedNode } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";

export const story10MultiPartyTranscript: EvalFixture = {
  name: "10-multi-party-transcript",
  description:
    "Multi-party transcript attributes claims to the right speakers; user-self collapses to assertedByKind=user.",
  setup: async (ctx) => {
    // Pre-existing Bob Person — passed via `knownParticipants` so the
    // speaker resolver doesn't mint a placeholder for him.
    await seedNode(ctx, { name: "bob", type: "Person", label: "Bob" });
  },
  steps: [
    {
      kind: "ingestTranscript",
      transcriptId: "transcript-multi-1",
      occurredAt: new Date("2026-04-30T10:00:00Z"),
      utterances: [
        { speakerLabel: "Marcel", content: "I shipped the spec." },
        {
          speakerLabel: "Bob",
          content: "Cool — I'd prefer a tighter spec next round.",
        },
        {
          speakerLabel: "Stranger",
          content: "Either way, let's ship by Friday.",
        },
      ],
      userSelfAliases: ["Marcel"],
      knownParticipants: [{ label: "Bob", nodeName: "bob" }],
      extractionStub: {
        nodes: [
          { id: "temp_object_spec", type: "Object", label: "the spec" },
        ],
        attributeClaims: [
          {
            subjectId: "temp_object_spec",
            predicate: "HAS_STATUS",
            objectValue: "completed",
            statement: "Marcel completed the spec.",
            sourceRef: "transcript-multi-1:0",
            assertionKind: "user",
            assertedBySpeakerLabel: "Marcel",
          },
          {
            subjectId: "temp_object_spec",
            predicate: "HAS_PREFERENCE",
            objectValue: "tighter spec",
            statement: "Bob prefers a tighter spec.",
            sourceRef: "transcript-multi-1:1",
            assertionKind: "participant",
            assertedBySpeakerLabel: "Bob",
          },
          {
            subjectId: "temp_object_spec",
            predicate: "HAS_GOAL",
            objectValue: "ship by friday",
            statement: "Stranger wants to ship by Friday.",
            sourceRef: "transcript-multi-1:2",
            assertionKind: "participant",
            assertedBySpeakerLabel: "Stranger",
          },
        ],
      },
    },
  ],
  expectations: {
    claimCounts: [
      {
        description: "Marcel (user-self) speaker → assertedByKind=user",
        assertedByKind: "user",
        exactCount: 1,
      },
      {
        description: "two non-self speakers → 2 participant claims",
        assertedByKind: "participant",
        exactCount: 2,
      },
    ],
    nodeCounts: [
      {
        description:
          "three Person nodes: user-self (lazily created), Bob, Stranger placeholder",
        type: "Person",
        exactCount: 3,
      },
    ],
    custom: [
      {
        description:
          "user-self claim has assertedByNodeId=null; participant claims have it set; placeholder Person carries the unresolvedSpeaker flag",
        run: async (ctx) => {
          const userClaims = await ctx.db
            .select({
              id: claims.id,
              predicate: claims.predicate,
              assertedByKind: claims.assertedByKind,
              assertedByNodeId: claims.assertedByNodeId,
            })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.assertedByKind, "user"),
              ),
            );
          if (userClaims.length !== 1) {
            return {
              pass: false,
              message: `expected 1 user claim, got ${userClaims.length}`,
            };
          }
          if (userClaims[0]!.assertedByNodeId !== null) {
            return {
              pass: false,
              message: `user claim has assertedByNodeId=${userClaims[0]!.assertedByNodeId}, expected null`,
            };
          }

          const bobNodeId = ctx.nodes.get("bob");
          const bobClaims = await ctx.db
            .select({
              assertedByNodeId: claims.assertedByNodeId,
              predicate: claims.predicate,
            })
            .from(claims)
            .where(
              and(
                eq(claims.userId, ctx.userId),
                eq(claims.predicate, "HAS_PREFERENCE"),
              ),
            );
          if (bobClaims.length !== 1) {
            return {
              pass: false,
              message: `expected 1 HAS_PREFERENCE claim, got ${bobClaims.length}`,
            };
          }
          if (bobClaims[0]!.assertedByNodeId !== bobNodeId) {
            return {
              pass: false,
              message: `Bob's claim has assertedByNodeId=${bobClaims[0]!.assertedByNodeId}, expected ${bobNodeId}`,
            };
          }

          const placeholder = await ctx.db
            .select({
              nodeId: nodes.id,
              additional: nodeMetadata.additionalData,
            })
            .from(nodes)
            .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
            .where(
              and(
                eq(nodes.userId, ctx.userId),
                eq(nodes.nodeType, "Person"),
                eq(nodeMetadata.label, "Stranger"),
              ),
            );
          if (placeholder.length !== 1) {
            return {
              pass: false,
              message: `expected 1 Stranger placeholder Person, got ${placeholder.length}`,
            };
          }
          const additional = placeholder[0]!.additional as
            | Record<string, unknown>
            | null;
          if (additional?.["unresolvedSpeaker"] !== true) {
            return {
              pass: false,
              message: `placeholder missing unresolvedSpeaker flag (got ${JSON.stringify(additional)})`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
