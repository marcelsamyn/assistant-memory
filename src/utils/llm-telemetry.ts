import type { ModelTask } from "./models";

/**
 * Provider-neutral accounting for one LLM call. Deliberately not tied to any
 * observability vendor: Helicone (which we also tag via request headers) is a
 * convenience layer that may go away, whereas this event is the durable
 * signal we own. `task` is our own concept and only survives if we emit it
 * ourselves — providers can only ever give us a per-model breakdown.
 */
export interface LlmUsageEvent {
  task: ModelTask | "unknown";
  model: string;
  userId: string;
  promptTokens?: number | undefined;
  /** OpenRouter prompt-cache hit (prompt_tokens_details.cached_tokens). */
  cachedTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
}

/** The subset of the OpenAI/OpenRouter `usage` object we read. */
interface UsageLike {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

/** Flatten the provider `usage` object into {@link LlmUsageEvent} fields. */
export function normalizeUsage(
  usage: UsageLike | null | undefined,
): Pick<
  LlmUsageEvent,
  "promptTokens" | "cachedTokens" | "completionTokens" | "totalTokens"
> {
  return {
    promptTokens: usage?.prompt_tokens,
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens,
    completionTokens: usage?.completion_tokens,
    totalTokens: usage?.total_tokens,
  };
}

/**
 * Emit one LLM-call accounting event as a single structured stdout line.
 *
 * This is the one seam to repoint when the observability backend changes:
 * a log drain, an OpenTelemetry collector, a Sentry breadcrumb, or a
 * Postgres sink can all consume `type: "llm_usage"` to build per-task and
 * per-model cost dashboards without touching any call site.
 */
export function recordLlmUsage(event: LlmUsageEvent): void {
  console.log(JSON.stringify({ type: "llm_usage", ...event }));
}
