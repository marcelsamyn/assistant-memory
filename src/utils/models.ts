import { env } from "./env";

/**
 * Logical LLM tasks the service performs. Each maps to a model id and is also
 * emitted as the `Helicone-Property-Task` header so spend can be broken down
 * per task in Helicone (independent of which model a task is routed to).
 *
 * The string values double as the Helicone property value, so keep them
 * stable and human-readable.
 */
export type ModelTask =
  | "graph_extraction"
  | "document_spine"
  | "transcript_segmentation"
  | "conversation_summary"
  | "graph_cleanup"
  | "atlas"
  | "profile_synthesis"
  | "dream"
  | "deep_research";

/**
 * Per-task overrides. An undefined entry (the default for every task) means
 * "inherit MODEL_ID_GRAPH_EXTRACTION" — see {@link modelForTask}.
 */
const TASK_MODEL_OVERRIDES: Record<ModelTask, string | undefined> = {
  graph_extraction: undefined,
  document_spine: env.MODEL_ID_DOCUMENT_SPINE,
  transcript_segmentation: env.MODEL_ID_TRANSCRIPT_SEGMENTATION,
  conversation_summary: env.MODEL_ID_CONVERSATION_SUMMARY,
  graph_cleanup: env.MODEL_ID_GRAPH_CLEANUP,
  atlas: env.MODEL_ID_ATLAS,
  profile_synthesis: env.MODEL_ID_PROFILE_SYNTHESIS,
  dream: env.MODEL_ID_DREAM,
  deep_research: env.MODEL_ID_DEEP_RESEARCH,
};

/**
 * Resolve the model id for a task.
 *
 * Safe fallback: every task falls back to `MODEL_ID_GRAPH_EXTRACTION` — the
 * single model the system used before tiering existed — so behavior is
 * unchanged until a task's `MODEL_ID_*` override is set. Swap one task at a
 * time and roll back by unsetting its env var.
 */
export function modelForTask(task: ModelTask): string {
  return TASK_MODEL_OVERRIDES[task] ?? env.MODEL_ID_GRAPH_EXTRACTION;
}

/** Default per-completion output-token ceiling. */
export const MODEL_MAX_OUTPUT_TOKENS = env.MODEL_MAX_OUTPUT_TOKENS;
