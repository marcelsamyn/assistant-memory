import { describe, expect, it } from "vitest";
import { toConversationMessages } from "~/lib/source-conversation";
import { newTypeId } from "~/types/typeid";

const TRANSCRIPT = { byUtteranceIndex: true };
const CHAT = { byUtteranceIndex: false };
const createdAt = new Date("2026-10-01T10:00:00.000Z");
const meetingStart = "2026-10-01T09:00:00.000Z";

type Fields = Partial<{
  rawContent: string;
  speakerLabel: string;
  speakerNodeId: string;
  role: string;
  name: string;
  timestamp: string;
}>;

function row(externalId: string, fields: Fields) {
  return {
    id: newTypeId("source"),
    externalId,
    createdAt,
    rawContent: fields.rawContent ?? null,
    speakerLabel: fields.speakerLabel ?? null,
    speakerNodeId: fields.speakerNodeId ?? null,
    role: fields.role ?? null,
    name: fields.name ?? null,
    timestamp: fields.timestamp ?? null,
  };
}

describe("toConversationMessages", () => {
  it("orders transcript utterances by index, not by fallback timestamps", () => {
    const speakerNodeId = newTypeId("node");
    // Utterances 0 and 11 carried their own times; the rest fell back to the
    // meeting start, which is earlier than utterance 0.
    const rows = [
      row("meet-42:11", {
        rawContent: "last",
        speakerLabel: "Marcel",
        timestamp: "2026-10-01T09:30:00.000Z",
      }),
      row("meet-42:2", {
        rawContent: "middle",
        speakerLabel: "Bob",
        speakerNodeId,
        timestamp: meetingStart,
      }),
      row("meet-42:0", {
        rawContent: "first",
        speakerLabel: "Marcel",
        timestamp: "2026-10-01T09:05:00.000Z",
      }),
    ];

    const messages = toConversationMessages(rows, TRANSCRIPT);

    expect(messages.map((m) => m.text)).toEqual(["first", "middle", "last"]);
    expect(messages[1]).toMatchObject({
      speaker: "Bob",
      speakerNodeId,
      role: null,
      timestamp: new Date(meetingStart),
    });
  });

  it("orders chat turns by time, even when their ids look numeric", () => {
    const rows = [
      row("1", {
        rawContent: "Sure.",
        role: "assistant",
        timestamp: "2026-10-01T09:01:00.000Z",
      }),
      row("2", {
        rawContent: "Remind me tomorrow.",
        role: "user",
        name: "Marcel",
        timestamp: "2026-10-01T09:00:00.000Z",
      }),
    ];

    const messages = toConversationMessages(rows, CHAT);

    expect(messages.map((m) => [m.speaker, m.role, m.text])).toEqual([
      ["Marcel", "user", "Remind me tomorrow."],
      ["assistant", "assistant", "Sure."],
    ]);
  });

  it("keeps a message with malformed provenance instead of failing the read", () => {
    const [message] = toConversationMessages(
      [
        row("meet-42:0", {
          rawContent: "Hello",
          speakerNodeId: "not-a-node-id",
          timestamp: "yesterday-ish",
        }),
      ],
      TRANSCRIPT,
    );

    expect(message).toMatchObject({
      speaker: null,
      speakerNodeId: null,
      timestamp: null,
      text: "Hello",
    });
  });
});
