import {
  chunkIntoBatches,
  extractConversationTurns,
  latestTimestamp,
  parseExport,
  slugify,
  toUtterances,
  turnsAfter,
  type ConversationTurn,
} from "./parse.js";
import { describe, expect, test } from "vitest";

/**
 * Mirrors the real Google AI Studio export shape: a `chunkedPrompt.chunks`
 * array where each chunk carries extra keys we don't consume (driveDocument,
 * finishReason, parts, thinkingBudget…). The fixture deliberately includes the
 * four exclusion cases the real file contains: a Drive-attachment chunk with no
 * inline text (a pasted dossier / book), a model "thinking" chunk, an errored
 * generation, and a whitespace-only turn.
 */
const exportFixture = {
  runSettings: { temperature: 1 },
  systemInstruction: { parts: [{ text: "be a coach" }] },
  chunkedPrompt: {
    chunks: [
      {
        role: "user",
        createTime: "2026-05-26T11:00:00.000Z",
        driveDocument: { id: "1vNzBi7XfeRL2nB24Kbks6ThqyEq8i1Lm" },
      },
      {
        role: "user",
        createTime: "2026-05-26T11:01:00.000Z",
        text: "I want some guidance.",
      },
      {
        role: "model",
        createTime: "2026-05-26T11:01:30.000Z",
        isThought: true,
        thinkingBudget: 8000,
        text: "The user wants coaching. I should open warmly.",
      },
      {
        role: "model",
        createTime: "2026-05-26T11:02:00.000Z",
        finishReason: "STOP",
        parts: [{ text: "Welcome." }, { text: " Let's begin." }],
        text: "Welcome. Let's begin.",
      },
      {
        role: "model",
        createTime: "2026-05-26T11:03:00.000Z",
        errorMessage: "model overloaded",
      },
      {
        role: "user",
        createTime: "2026-05-26T11:03:30.000Z",
        text: "   \n  ",
      },
      {
        role: "user",
        createTime: "2026-05-26T11:04:00.000Z",
        text: "Tell me about purpose.",
      },
      {
        role: "model",
        createTime: "2026-05-26T11:05:00.000Z",
        text: "Purpose is the deepest current of a life.",
      },
    ],
  },
};

describe("parseExport", () => {
  test("accepts a real-shaped export with unknown chunk keys", () => {
    const parsed = parseExport(exportFixture);
    expect(parsed.chunkedPrompt.chunks).toHaveLength(8);
  });

  test("throws on input missing chunkedPrompt.chunks", () => {
    expect(() => parseExport({ chunkedPrompt: {} })).toThrow();
  });
});

describe("extractConversationTurns", () => {
  test("keeps only real turns, dropping drive docs, thoughts, errors, and blanks", () => {
    const turns = extractConversationTurns(parseExport(exportFixture));
    expect(turns.map((t) => t.text)).toEqual([
      "I want some guidance.",
      "Welcome. Let's begin.",
      "Tell me about purpose.",
      "Purpose is the deepest current of a life.",
    ]);
  });

  test("preserves role and createTime on kept turns", () => {
    const turns = extractConversationTurns(parseExport(exportFixture));
    expect(turns[0]).toEqual({
      role: "user",
      text: "I want some guidance.",
      createTime: "2026-05-26T11:01:00.000Z",
    });
    expect(turns[1]?.role).toBe("model");
  });
});

describe("toUtterances", () => {
  test("labels user turns as self and model turns as the coach, carrying timestamps", () => {
    const turns = extractConversationTurns(parseExport(exportFixture));
    const utterances = toUtterances(turns, {
      selfLabel: "Marcel",
      coachLabel: "David Deida",
    });
    expect(utterances.slice(0, 2)).toEqual([
      {
        speakerLabel: "Marcel",
        content: "I want some guidance.",
        timestamp: "2026-05-26T11:01:00.000Z",
      },
      {
        speakerLabel: "David Deida",
        content: "Welcome. Let's begin.",
        timestamp: "2026-05-26T11:02:00.000Z",
      },
    ]);
  });

  test("omits timestamp when a turn has no createTime", () => {
    const utterances = toUtterances([{ role: "user", text: "hi" }], {
      selfLabel: "You",
      coachLabel: "Assistant",
    });
    expect(utterances).toEqual([{ speakerLabel: "You", content: "hi" }]);
    expect(utterances[0]).not.toHaveProperty("timestamp");
  });
});

describe("turnsAfter", () => {
  const turns: ConversationTurn[] = [
    { role: "user", text: "a", createTime: "2026-05-26T11:01:00.000Z" },
    { role: "model", text: "b", createTime: "2026-05-26T11:02:00.000Z" },
    { role: "user", text: "c", createTime: "2026-05-26T11:04:00.000Z" },
  ];

  test("returns every turn when no watermark is set", () => {
    expect(turnsAfter(turns, undefined)).toHaveLength(3);
  });

  test("returns only turns strictly newer than the watermark", () => {
    expect(
      turnsAfter(turns, "2026-05-26T11:02:00.000Z").map((t) => t.text),
    ).toEqual(["c"]);
  });
});

describe("chunkIntoBatches", () => {
  test("splits into ordered groups with a trailing remainder", () => {
    expect(chunkIntoBatches([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("rejects a batch size below 1", () => {
    expect(() => chunkIntoBatches([1, 2], 0)).toThrow();
  });
});

describe("latestTimestamp", () => {
  test("returns the maximum createTime across turns", () => {
    expect(
      latestTimestamp([
        { role: "user", text: "a", createTime: "2026-05-26T11:01:00.000Z" },
        { role: "model", text: "b", createTime: "2026-05-26T11:05:00.000Z" },
        { role: "user", text: "c", createTime: "2026-05-26T11:04:00.000Z" },
      ]),
    ).toBe("2026-05-26T11:05:00.000Z");
  });

  test("returns undefined for an empty list", () => {
    expect(latestTimestamp([])).toBeUndefined();
  });
});

describe("slugify", () => {
  test("lowercases, strips extension, and dash-joins", () => {
    expect(slugify("Guidance On Awareness And Purpose.json")).toBe(
      "guidance-on-awareness-and-purpose",
    );
  });

  test("falls back to 'aistudio' for empty input", () => {
    expect(slugify("***")).toBe("aistudio");
  });
});
