import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionSystemMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources.mjs";
import { z } from "zod";
import { env } from "~/utils/env";
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
 * Total attempts (1 initial + retries) for a structured completion whose
 * failure looks like a transient bad-response shape rather than well-formed
 * data we disagree with. Kept small so a deterministically broken call still
 * fails fast instead of hammering the provider.
 */
export const STRUCTURED_COMPLETION_MAX_ATTEMPTS = 3;

/**
 * True when a failed `chat.completions.parse` looks like a transient
 * bad-response shape worth re-issuing, as opposed to a deterministic problem
 * (auth, rate limit, a schema mismatch in well-formed JSON) that a retry
 * can't fix.
 *
 * - `SyntaxError`: the SDK runs `JSON.parse` on the response body inside
 *   `.parse()` (via `zodResponseFormat`'s `$parseRaw`). A provider that
 *   truncates a long structured response mid-string — common with custom
 *   base-URL providers that don't flag `finish_reason: "length"` — surfaces
 *   here as "Unterminated string in JSON at position …". The model is
 *   stochastic, so a fresh attempt usually returns a complete, parseable body.
 * - {@link MalformedUpstreamCompletionError}: provider returned an envelope
 *   without `choices` (already normalized from the SDK's TypeError below).
 * - `LengthFinishReasonError`: provider *did* flag length truncation; matched
 *   by name to avoid importing the SDK error class. Output length varies
 *   run-to-run, so a retry can still land under the cap.
 *
 * A `ZodError` (well-formed JSON that violates the schema) is intentionally
 * NOT retried — that signals a prompt/schema bug, and retrying would just burn
 * tokens while masking it.
 */
function isRetryableCompletionError(err: unknown): boolean {
  if (err instanceof SyntaxError) return true;
  if (err instanceof MalformedUpstreamCompletionError) return true;
  return err instanceof Error && err.name === "LengthFinishReasonError";
}

/**
 * Wrapper around `client.chat.completions.parse` that normalizes the SDK's
 * malformed-response `TypeError` into {@link MalformedUpstreamCompletionError}
 * and retries transient bad-response shapes (truncated/unparseable JSON,
 * missing-`choices` envelopes, length truncation) up to
 * {@link STRUCTURED_COMPLETION_MAX_ATTEMPTS} times. Retries are immediate:
 * the failure modes covered here are response-shape problems, not rate
 * limiting, so backing off would only add latency.
 *
 * Signature mirrors the SDK so call sites preserve full type inference on the
 * parsed payload.
 */
export async function parseStructuredCompletion<
  Body extends ChatCompletionCreateParamsNonStreaming,
>(client: OpenAI, body: Body) {
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= STRUCTURED_COMPLETION_MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      return await client.chat.completions.parse(body);
    } catch (err) {
      lastError = isMalformedUpstreamCompletion(err)
        ? new MalformedUpstreamCompletionError({ cause: err })
        : err;

      const canRetry =
        attempt < STRUCTURED_COMPLETION_MAX_ATTEMPTS &&
        isRetryableCompletionError(lastError);
      if (!canRetry) throw lastError;

      const detail =
        lastError instanceof Error
          ? `${lastError.name}: ${lastError.message}`
          : String(lastError);
      console.warn(
        `parseStructuredCompletion: attempt ${attempt}/${STRUCTURED_COMPLETION_MAX_ATTEMPTS} failed (${detail}); retrying`,
      );
    }
  }
  // The loop returns on success and throws on a non-retryable or final-attempt
  // failure, so this is unreachable; it satisfies the type checker.
  throw lastError;
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

export async function performStructuredAnalysis<
  S extends z.ZodObject<z.ZodRawShape>,
>({
  userId,
  prompt,
  systemPrompt,
  schema,
}: {
  userId: string;
  prompt: string;
  systemPrompt?: string;
  schema: S;
}): Promise<z.infer<S>> {
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
