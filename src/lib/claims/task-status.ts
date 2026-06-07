import { TaskStatusEnum, type TaskStatus } from "~/types/graph";

/**
 * Off-vocabulary `HAS_TASK_STATUS` labels mapped back onto the canonical
 * {@link TaskStatusEnum}. Keys are already normalized (see {@link normalize}):
 * lowercased and with runs of whitespace/hyphens collapsed to a single `_`.
 *
 * Kept deliberately conservative — only labels whose intent is unambiguous.
 * This guards the read model against the `completed`/`cancelled` vocabulary
 * drift documented in docs/sdk-consumer-migration.md, where a consumer's tool
 * schema diverged from the SDK enum. `failed` maps to `abandoned` because it
 * is the only terminal "closed but not completed" value in the enum — the
 * extraction LLM emits it for tasks the user gave up on or could not finish.
 *
 * NOTE: each synonym needs a SQL twin so rows already in the store are
 * repaired, not just freshly-extracted ones. The base map was seeded by
 * `drizzle/0017_task_status_vocabulary_backfill.sql`; `failed` was added in
 * `drizzle/0018_failed_task_status_backfill.sql`. Keep them in sync.
 */
const TASK_STATUS_SYNONYMS: Readonly<Record<string, TaskStatus>> = {
  completed: "done",
  complete: "done",
  finished: "done",
  cancelled: "abandoned",
  canceled: "abandoned",
  dropped: "abandoned",
  failed: "abandoned",
  todo: "pending",
  to_do: "pending",
  not_started: "pending",
  doing: "in_progress",
  started: "in_progress",
  wip: "in_progress",
};

function normalize(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/**
 * Coerce a raw `HAS_TASK_STATUS` objectValue — from the extraction LLM, an SDK
 * consumer, or a legacy row — onto the canonical {@link TaskStatusEnum}.
 *
 * Normalization handles casing/spacing variants ("In Progress" → "in_progress"),
 * and a small synonym table handles well-known aliases ("completed" → "done").
 * Returns `null` when the value can't be confidently mapped, so callers can
 * skip or reject it rather than crash the request.
 */
export function coerceTaskStatus(
  raw: string | null | undefined,
): TaskStatus | null {
  if (raw === null || raw === undefined) return null;
  const normalized = normalize(raw);
  const direct = TaskStatusEnum.safeParse(normalized);
  if (direct.success) return direct.data;
  return TASK_STATUS_SYNONYMS[normalized] ?? null;
}
