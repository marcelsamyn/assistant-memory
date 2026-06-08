/**
 * Candidate commitments section assembler.
 *
 * Surfaces the inferred-but-unconfirmed tasks that `getCandidateCommitments`
 * returns (the band `getOpenCommitments` deliberately hides). The usage copy
 * frames these as tentative so the assistant raises them for confirmation
 * rather than stating them as settled work. Empty list → no section. Capped at
 * 20 by stated_at desc.
 *
 * Confirmation/dismissal happen through the `confirm_commitment` /
 * `dismiss_commitment` tools, keyed by the task node id.
 */
import type { ContextSectionCandidateCommitments } from "../types";
import { formatDue } from "./open-commitments";
import { getCandidateCommitments } from "~/lib/query/open-commitments";
import type { OpenCommitment } from "~/lib/schemas/open-commitments";

const MAX_CANDIDATES = 20;
const USAGE =
  "Unconfirmed commitments the assistant inferred — NOT authoritative open work. Raise them with the user to confirm ('looks like you committed to X — track it?'); on agreement call confirm_commitment with the task's node id, on rejection call dismiss_commitment. Never present these as settled tasks.";

function renderLine(commitment: OpenCommitment): string {
  const label = commitment.label ?? "(unlabeled task)";
  const parts: string[] = [
    `- ${label} [${commitment.status}] id=${commitment.taskId}`,
  ];
  if (commitment.owner !== null) {
    parts.push(`owner=${commitment.owner.label ?? "(unlabeled)"}`);
  }
  const due = formatDue(commitment);
  if (due !== null) parts.push(due);
  return parts.join(" ");
}

export async function assembleCandidateCommitmentsSection(
  userId: string,
): Promise<ContextSectionCandidateCommitments | null> {
  const all = await getCandidateCommitments({ userId });
  if (all.length === 0) return null;

  const sorted = [...all].sort(
    (a, b) => b.statedAt.getTime() - a.statedAt.getTime(),
  );
  const top = sorted.slice(0, MAX_CANDIDATES);
  const content = top.map(renderLine).join("\n");

  return {
    kind: "candidate_commitments",
    content,
    usage: USAGE,
  };
}
