import {
  MalformedUpstreamCompletionError,
  STRUCTURED_COMPLETION_MAX_ATTEMPTS,
  parseStructuredCompletion,
} from "./ai";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

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

  it("retries a truncated JSON body and returns the parsed result on a later attempt", async () => {
    // The SDK's `.parse()` runs JSON.parse on the response body; a provider
    // that truncates a long structured response surfaces here as a SyntaxError
    // ("Unterminated string in JSON …"). The next attempt gets a clean body.
    const expected = { choices: [{ message: { parsed: { ok: true } } }] };
    const parse = vi
      .fn()
      .mockRejectedValueOnce(
        new SyntaxError(
          "Unterminated string in JSON at position 5986 (line 170 column 40)",
        ),
      )
      .mockResolvedValueOnce(expected);
    const client = buildClient(parse);

    const result = await parseStructuredCompletion(client, {
      messages: [{ role: "user", content: "hi" }],
      model: "test",
    });

    expect(result).toBe(expected);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("exhausts retries and throws the last error for a persistently truncated body", async () => {
    const err = new SyntaxError("Unterminated string in JSON at position 10");
    const parse = vi.fn().mockRejectedValue(err);
    const client = buildClient(parse);

    await expect(
      parseStructuredCompletion(client, {
        messages: [{ role: "user", content: "hi" }],
        model: "test",
      }),
    ).rejects.toBe(err);
    expect(parse).toHaveBeenCalledTimes(STRUCTURED_COMPLETION_MAX_ATTEMPTS);
  });

  it("retries a missing-choices malformed upstream response", async () => {
    const err = new TypeError(
      "Cannot read properties of undefined (reading 'map')",
    );
    err.stack =
      "TypeError: Cannot read properties of undefined (reading 'map')\n" +
      "    at parseChatCompletion (file:///app/node_modules/openai/lib/parser.mjs:75:40)";
    const expected = { choices: [{ message: { parsed: { ok: true } } }] };
    const parse = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(expected);
    const client = buildClient(parse);

    const result = await parseStructuredCompletion(client, {
      messages: [{ role: "user", content: "hi" }],
      model: "test",
    });

    expect(result).toBe(expected);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("retries a length-truncation error flagged by the provider", async () => {
    // The SDK throws LengthFinishReasonError when finish_reason === "length";
    // matched by name so we don't need to import the SDK error class.
    const err = new Error("Could not parse response content as the length …");
    err.name = "LengthFinishReasonError";
    const expected = { choices: [{ message: { parsed: { ok: true } } }] };
    const parse = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(expected);
    const client = buildClient(parse);

    const result = await parseStructuredCompletion(client, {
      messages: [{ role: "user", content: "hi" }],
      model: "test",
    });

    expect(result).toBe(expected);
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic errors like rate limits", async () => {
    const sentinel = new Error("rate limited");
    const parse = vi.fn().mockRejectedValue(sentinel);
    const client = buildClient(parse);

    await expect(
      parseStructuredCompletion(client, {
        messages: [{ role: "user", content: "hi" }],
        model: "test",
      }),
    ).rejects.toBe(sentinel);
    expect(parse).toHaveBeenCalledTimes(1);
  });
});
