/**
 * The status a Task is given when it would otherwise have none.
 *
 * A Task's commitment-ness is carried entirely by its `HAS_TASK_STATUS` claim:
 * every commitment read model (`getOpenCommitments` / `getCandidateCommitments`
 * / `listCommitments`) anchors its query on that claim, so a Task with no
 * status claim is structurally invisible as a commitment even though it still
 * appears in node/type/search/graph surfaces. The invariant is therefore "every
 * Task has exactly one active `HAS_TASK_STATUS` claim, unless it was
 * deliberately dismissed (status retracted) and is awaiting pruning."
 *
 * This module is the single source of truth for the status we synthesize when
 * that invariant would otherwise be violated — at ingestion (a Task the
 * extractor minted without a usable status), at `createNode` (a Task created
 * via the raw `/node/create` path with no status claim), and during the
 * `recover-statusless-commitments` backfill/self-heal sweep. Keeping the three
 * enforcement points in agreement means every read surface keeps its simple,
 * uniform claim-anchored query.
 */
import type { AssertedByKind, TaskStatus } from "~/types/graph";

/**
 * Synthesized tasks open as `pending`: we know the Task exists and is not yet
 * resolved, but nothing in the source established progress.
 */
export const DEFAULT_TASK_STATUS: TaskStatus = "pending";

/**
 * Provenance for a synthesized default status. `assistant_inferred` lands the
 * Task in the *candidate* band (`getCandidateCommitments`) rather than the
 * trusted open-commitments view — consistent with "background ingestion never
 * mints a firm commitment" and the commitment-curation loop, where inferred
 * tasks are surfaced for the user to confirm or dismiss. A recovered Task is
 * thus visible and actionable without being asserted as a settled obligation.
 */
export const DEFAULT_TASK_STATUS_KIND: AssertedByKind = "assistant_inferred";

/** Natural-language statement for a synthesized default status claim. */
export function defaultTaskStatusStatement(label: string | null): string {
  return `${label ?? "Task"} is ${DEFAULT_TASK_STATUS}.`;
}
