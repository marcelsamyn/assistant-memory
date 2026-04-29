/**
 * Open commitments section assembler.
 *
 * Reuses `getOpenCommitments` (the canonical lifecycle-aware view) and
 * renders compact lines with optional owner/due metadata. Empty list → no
 * section. Capped at 20 commitments by stated_at desc.
 *
 * Evidence refs are intentionally omitted: `OpenCommitment` exposes the
 * task node id and source id but not the latest `HAS_TASK_STATUS` claim id
 * — surfacing the source without the claim id would be lossy. Phase 3.6's
 * node-card synthesis is the right place to add task-level evidence.
 */
import { getOpenCommitments } from "~/lib/query/open-commitments";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";
import type { ContextSectionOpenCommitments } from "../types";

const MAX_COMMITMENTS = 20;
const USAGE =
  "Pending or in-progress only — never list these as todo unless they appear here. Treat as the authoritative open-work view; do not infer commitments from search results.";

function renderLine(commitment: OpenCommitment): string {
  const label = commitment.label ?? "(unlabeled task)";
  const parts: string[] = [`- ${label} [${commitment.status}]`];
  if (commitment.owner !== null) {
    parts.push(`owner=${commitment.owner.label ?? "(unlabeled)"}`);
  }
  if (commitment.dueOn !== null) {
    parts.push(`due=${commitment.dueOn}`);
  }
  return parts.join(" ");
}

export async function assembleOpenCommitmentsSection(
  userId: string,
): Promise<ContextSectionOpenCommitments | null> {
  const all = await getOpenCommitments({ userId });
  if (all.length === 0) return null;

  const sorted = [...all].sort(
    (a, b) => b.statedAt.getTime() - a.statedAt.getTime(),
  );
  const top = sorted.slice(0, MAX_COMMITMENTS);
  const content = top.map(renderLine).join("\n");

  return {
    kind: "open_commitments",
    content,
    usage: USAGE,
  };
}
