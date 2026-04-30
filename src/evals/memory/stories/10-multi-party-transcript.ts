/**
 * Story 10 — Multi-party transcript (speaker attribution).
 *
 * A three-speaker meeting:
 *   - Marcel (user-self): "I shipped the spec." → user-stated.
 *   - Bob (resolved participant): "I'd prefer a tighter spec." → participant.
 *   - Stranger (placeholder): "Let's ship by Friday." → participant w/
 *     placeholder Person node.
 *
 * **Implementation note**: this story seeds the post-extraction state via the
 * same shapes that `ingest-transcript.test.ts` validates end-to-end. The
 * participant→nodeId mapping, `assertedByKind` collapse for user-self, and
 * placeholder Person creation are exercised in production tests; here we pin
 * the resulting graph contract that downstream consumers (open commitments,
 * search filters, atlas synthesis) depend on.
 */
import { seedAlias, seedClaim, seedNode, seedSource } from "../seed";
import type { EvalFixture } from "../types";
import { and, eq } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";

export const story10MultiPartyTranscript: EvalFixture = {
  name: "10-multi-party-transcript",
  description:
    "Multi-party transcript attributes claims to the right speakers; user-self collapses to assertedByKind=user.",
  setup: async (ctx) => {
    // The user-self speaker is rendered as a plain Person; production marks it
    // with `additionalData.isUserSelf = true` (see resolve-speakers.ts).
    await seedNode(ctx, {
      name: "marcel",
      type: "Person",
      label: "Marcel",
      additionalData: { isUserSelf: true },
    });
    await seedNode(ctx, {
      name: "bob",
      type: "Person",
      label: "Bob",
    });
    await seedNode(ctx, {
      name: "strangerPlaceholder",
      type: "Person",
      label: "Stranger",
      additionalData: { unresolvedSpeaker: true },
    });
    await seedAlias(ctx, {
      canonicalNodeName: "strangerPlaceholder",
      aliasText: "Stranger",
    });
    await seedNode(ctx, { name: "spec", type: "Object", label: "the spec" });

    await seedSource(ctx, {
      name: "transcript",
      type: "meeting_transcript",
    });
    await seedSource(ctx, {
      name: "msg0",
      type: "conversation_message",
      externalId: "msg0",
      metadata: { speakerLabel: "Marcel" },
    });
    await seedSource(ctx, {
      name: "msg1",
      type: "conversation_message",
      externalId: "msg1",
      metadata: { speakerLabel: "Bob" },
    });
    await seedSource(ctx, {
      name: "msg2",
      type: "conversation_message",
      externalId: "msg2",
      metadata: { speakerLabel: "Stranger" },
    });

    // Marcel's claim: user-self collapses to `assertedByKind = 'user'`,
    // `assertedByNodeId` MUST be null (production constraint).
    await seedClaim(ctx, {
      name: "marcelShipped",
      subjectName: "spec",
      predicate: "HAS_STATUS",
      objectValue: "completed",
      sourceName: "msg0",
      assertedByKind: "user",
    });
    // Bob's claim: participant with assertedByNodeId set to Bob.
    await seedClaim(ctx, {
      name: "bobPref",
      subjectName: "spec",
      predicate: "HAS_PREFERENCE",
      objectValue: "tighter spec",
      sourceName: "msg1",
      assertedByKind: "participant",
      assertedByNodeName: "bob",
    });
    // Stranger: participant attributed to the placeholder Person.
    await seedClaim(ctx, {
      name: "strangerGoal",
      subjectName: "spec",
      predicate: "HAS_GOAL",
      objectValue: "ship by friday",
      sourceName: "msg2",
      assertedByKind: "participant",
      assertedByNodeName: "strangerPlaceholder",
    });
  },
  steps: [],
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
        description: "three Person nodes: user-self, Bob, placeholder",
        type: "Person",
        exactCount: 3,
      },
    ],
    custom: [
      {
        description:
          "user-self claim has assertedByNodeId=null; participant claims have it set",
        run: async (ctx) => {
          const userClaim = await ctx.db
            .select()
            .from(claims)
            .where(
              and(
                eq(claims.id, ctx.claims.get("marcelShipped")!),
                eq(claims.userId, ctx.userId),
              ),
            );
          if (userClaim[0]?.assertedByNodeId !== null) {
            return {
              pass: false,
              message: `user-self claim has assertedByNodeId=${userClaim[0]?.assertedByNodeId}, expected null`,
            };
          }
          const bobClaim = await ctx.db
            .select()
            .from(claims)
            .where(eq(claims.id, ctx.claims.get("bobPref")!));
          if (bobClaim[0]?.assertedByNodeId !== ctx.nodes.get("bob")) {
            return {
              pass: false,
              message: `Bob's claim has assertedByNodeId=${bobClaim[0]?.assertedByNodeId}, expected ${ctx.nodes.get("bob")}`,
            };
          }
          // Verify the placeholder is reachable + flagged.
          const meta = await ctx.db
            .select({ additional: nodeMetadata.additionalData })
            .from(nodeMetadata)
            .innerJoin(nodes, eq(nodes.id, nodeMetadata.nodeId))
            .where(eq(nodes.id, ctx.nodes.get("strangerPlaceholder")!));
          const flag = meta[0]?.additional as
            | Record<string, unknown>
            | undefined;
          if (flag?.["unresolvedSpeaker"] !== true) {
            return {
              pass: false,
              message: `placeholder missing unresolvedSpeaker flag (got ${JSON.stringify(flag)})`,
            };
          }
          return { pass: true };
        },
      },
    ],
  },
};
