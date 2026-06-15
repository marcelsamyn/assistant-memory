import { buildIngestBody, targetFor } from "./targets.js";
import { describe, expect, test } from "vitest";

describe("targetFor", () => {
  test("memory host: direct transcript endpoint, Bearer auth, userId required", () => {
    const t = targetFor("memory", "https://mem.example.com");
    expect(t.endpoint).toBe("https://mem.example.com/transcript/ingest");
    expect(t.authHeaders("k")).toEqual({ Authorization: "Bearer k" });
    expect(t.requiresUserId).toBe(true);
  });

  test("petals host: proxy endpoint, x-api-key auth, userId derived", () => {
    const t = targetFor("petals", "https://petals.chat");
    expect(t.endpoint).toBe("https://petals.chat/api/memory/ingest/transcript");
    expect(t.authHeaders("k")).toEqual({ "x-api-key": "k" });
    expect(t.requiresUserId).toBe(false);
  });

  test("trims trailing slashes from the base url", () => {
    expect(targetFor("memory", "http://localhost:3000//").endpoint).toBe(
      "http://localhost:3000/transcript/ingest",
    );
  });
});

describe("buildIngestBody", () => {
  const utterances = [{ speakerLabel: "You", content: "hi" }];
  const base = {
    transcriptId: "t1",
    occurredAt: "2026-05-26T11:00:00.000Z",
    scope: "personal" as const,
    utterances,
    selfAliases: ["You"],
  };

  test("memory host includes the userId in the body", () => {
    const body = buildIngestBody({
      ...base,
      target: targetFor("memory", "u"),
      userId: "user_abc",
    });
    expect(body.userId).toBe("user_abc");
    expect(body.content).toEqual({ kind: "segmented", utterances });
  });

  test("petals host omits userId even if one is supplied", () => {
    const body = buildIngestBody({
      ...base,
      target: targetFor("petals", "u"),
      userId: "user_abc",
    });
    expect(body).not.toHaveProperty("userId");
  });

  test("throws when a memory host has no userId", () => {
    expect(() =>
      buildIngestBody({
        ...base,
        target: targetFor("memory", "u"),
        userId: undefined,
      }),
    ).toThrow(/user id/i);
  });
});
