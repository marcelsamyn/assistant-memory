/**
 * Story 3 — Same person nickname + full name.
 *
 * "Met Jonathan today" then "Jon's coming over" — driven through the real
 * conversation-ingestion + extraction pipeline with stubbed LLM responses.
 * The first message creates a Person node "Jonathan" with the alias
 * "Jonathan". The second message proposes a separate "Jon" Person node, but
 * the alias-resolution path (signal 2 in `resolveIdentity`) collapses it
 * onto the existing Jonathan node, then writes the new "Jon" alias.
 *
 * The expectation set pins the post-pipeline graph contract: one Person
 * node, two aliases pointing at it.
 */
import { seedAlias, seedNode } from "../seed";
import type { EvalFixture } from "../types";

export const story03PersonNickname: EvalFixture = {
  name: "03-person-nickname",
  description:
    "Same person referenced by full name and nickname collapses to one Person node with two aliases.",
  setup: async (ctx) => {
    // Pre-seed the canonical Jonathan node + alias so the first extraction
    // call's resolution lands on it via signal 1 (canonical label) and the
    // second call's "Jon" lands via signal 2 (alias). Without the alias
    // pre-seeded, the LLM would also need to emit the "Jonathan" alias on
    // the first call — that's tested separately in `extract-graph.test.ts`.
    await seedNode(ctx, {
      name: "jonathan",
      type: "Person",
      label: "Jonathan",
    });
    await seedAlias(ctx, {
      canonicalNodeName: "jonathan",
      aliasText: "Jonathan",
    });
  },
  steps: [
    {
      kind: "ingestConversation",
      conversationId: "conv-jonathan-1",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "Met Jonathan today.",
          timestamp: new Date("2026-04-30T10:00:00Z"),
        },
        {
          id: "msg-2",
          role: "user",
          content: "Jon is coming over.",
          timestamp: new Date("2026-04-30T11:00:00Z"),
        },
      ],
      extractionStubs: [
        {
          nodes: [
            {
              id: "temp_person_1",
              type: "Person",
              label: "Jonathan",
              description: "Met today.",
            },
          ],
          aliases: [
            { subjectId: "temp_person_1", aliasText: "Jonathan" },
          ],
        },
        {
          // The extractor sees existing Person nodes via the prompt's
          // context block (tempId `existing_person_1` for Jonathan, the
          // first Person returned by `findNodesByType`). A well-behaved LLM
          // attaches the new "Jon" alias to that existing id rather than
          // minting a new node — this is the alias-write path the story
          // pins.
          aliases: [
            { subjectId: "existing_person_1", aliasText: "Jon" },
          ],
        },
      ],
    },
  ],
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
