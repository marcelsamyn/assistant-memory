import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources.mjs";
import { z } from "zod";
import { getExtractionClientOverride } from "~/utils/test-overrides";

/**
 * Thrown when the upstream completion response is missing the standard
 * OpenAI envelope (no `choices` field). The OpenAI SDK's parser blows up
 * on this with a cryptic `TypeError: Cannot read properties of undefined
 * (reading 'map')`; we normalize it here so callers can decide whether to
 * retry, surface, or drop. Most commonly seen with custom-baseURL providers
 * returning error envelopes, empty bodies, or rate-limit JSON wrapped as 200.
 */
export class MalformedUpstreamCompletionError extends Error {
  override readonly name = "MalformedUpstreamCompletionError";
  constructor(options?: { cause?: unknown }) {
    super(
      "Upstream completion response was missing the `choices` field — likely a transient upstream issue.",
      options,
    );
  }
}

function isMalformedUpstreamCompletion(err: unknown): boolean {
  return (
    err instanceof TypeError &&
    err.message.includes("reading 'map'") &&
    typeof err.stack === "string" &&
    err.stack.includes("parseChatCompletion")
  );
}

/**
 * Wrapper around `client.beta.chat.completions.parse` that normalizes the
 * SDK's malformed-response `TypeError` into {@link MalformedUpstreamCompletionError}.
 * Signature mirrors the SDK so call sites preserve full type inference on
 * the parsed payload.
 */
export async function parseStructuredCompletion<
  Body extends ChatCompletionCreateParamsNonStreaming,
>(client: OpenAI, body: Body) {
  try {
    return await client.beta.chat.completions.parse(body);
  } catch (err) {
    if (isMalformedUpstreamCompletion(err)) {
      throw new MalformedUpstreamCompletionError({ cause: err });
    }
    throw err;
  }
}

export async function createCompletionClient(userId: string): Promise<OpenAI> {
  const override = getExtractionClientOverride();
  if (override) return override as OpenAI;
  const { OpenAI } = await import("openai");
  return new OpenAI({
    apiKey: env.MEMORY_OPENAI_API_KEY,
    baseURL: env.MEMORY_OPENAI_API_BASE_URL,
    defaultHeaders: {
      ...(env.HELICONE_API_KEY
        ? {
            "Helicone-Auth": `Bearer ${env.HELICONE_API_KEY}`,
            "Helicone-User-Id": userId,
          }
        : {}),
      "HTTP-Referer": "https://github.com/iamarcel/assistant-memory",
      "X-Title": "Assistant Memory",
    },
  });
}

export async function crateTextCompletion({
  userId,
  prompt,
  systemPrompt,
}: {
  userId: string;
  prompt: string;
  systemPrompt?: string;
}): Promise<string> {
  const client = await createCompletionClient(userId);
  const completion = await client.chat.completions.create({
    messages: [
      ...(systemPrompt
        ? [
            {
              role: "system",
              content: systemPrompt,
            } satisfies ChatCompletionSystemMessageParam,
          ]
        : []),
      {
        role: "user",
        content: prompt,
      } satisfies ChatCompletionUserMessageParam,
    ],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
  });

  return completion.choices[0]?.message.content ?? "";
}

export async function performStructuredAnalysis({
  userId,
  prompt,
  systemPrompt,
  schema,
}: {
  userId: string;
  prompt: string;
  systemPrompt?: string;
  schema: z.ZodObject<z.ZodRawShape>;
}): Promise<z.infer<typeof schema>> {
  if (!schema.description) throw new Error("Schema must have a description");

  const client = await createCompletionClient(userId);
  const completion = await parseStructuredCompletion(client, {
    messages: [
      ...(systemPrompt
        ? [
            {
              role: "system",
              content: systemPrompt,
            } satisfies ChatCompletionSystemMessageParam,
          ]
        : []),
      {
        role: "user",
        content: prompt,
      } satisfies ChatCompletionUserMessageParam,
    ],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
    response_format: zodResponseFormat(schema, schema.description),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("Failed to parse response");
  return parsed;
}
