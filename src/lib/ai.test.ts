import {
  MalformedUpstreamCompletionError,
  parseStructuredCompletion,
} from "./ai";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

function buildClient(parseImpl: () => Promise<unknown>): OpenAI {
  return {
    chat: {
      completions: {
        parse: parseImpl,
      },
    },
  } as unknown as OpenAI;
}

describe("parseStructuredCompletion", () => {
  it("returns the SDK's parsed completion on success", async () => {
    const expected = { choices: [{ message: { parsed: { ok: true } } }] };
    const client = buildClient(async () => expected);

    const result = await parseStructuredCompletion(client, {
      messages: [{ role: "user", content: "hi" }],
      model: "test",
    });

    expect(result).toBe(expected);
  });

  it("normalizes the SDK's missing-choices TypeError into MalformedUpstreamCompletionError", async () => {
    // Replicate the exact error the SDK throws when `completion.choices`
    // is undefined (e.g. provider returned an error envelope without the
    // OpenAI shape). The detector inspects message + stack, so both must
    // match production conditions.
    const err = new TypeError(
      "Cannot read properties of undefined (reading 'map')",
    );
    err.stack =
      "TypeError: Cannot read properties of undefined (reading 'map')\n" +
      "    at parseChatCompletion (file:///app/node_modules/openai/lib/parser.mjs:75:40)\n" +
      "    at Completions.parse (file:///app/node_modules/openai/resources/beta/chat/completions.mjs:22:42)";
    const client = buildClient(async () => {
      throw err;
    });

    await expect(
      parseStructuredCompletion(client, {
        messages: [{ role: "user", content: "hi" }],
        model: "test",
      }),
    ).rejects.toBeInstanceOf(MalformedUpstreamCompletionError);
  });

  it("passes unrelated errors through unchanged", async () => {
    const sentinel = new Error("rate limited");
    const client = buildClient(async () => {
      throw sentinel;
    });

    await expect(
      parseStructuredCompletion(client, {
        messages: [{ role: "user", content: "hi" }],
        model: "test",
      }),
    ).rejects.toBe(sentinel);
  });

  it("passes through TypeErrors that did not originate in parseChatCompletion", async () => {
    // A different `.map` TypeError from elsewhere in the code path should
    // not be misclassified as a malformed upstream response.
    const err = new TypeError(
      "Cannot read properties of undefined (reading 'map')",
    );
    err.stack =
      "TypeError: Cannot read properties of undefined (reading 'map')\n" +
      "    at someOtherFunction (file:///app/foo.mjs:1:1)";
    const client = buildClient(async () => {
      throw err;
    });

    await expect(
      parseStructuredCompletion(client, {
        messages: [{ role: "user", content: "hi" }],
        model: "test",
      }),
    ).rejects.toBe(err);
  });
});
