/**
 * Deterministic repair for the Task⟺status invariant.
 *
 * A Task's commitment-ness lives entirely in its `HAS_TASK_STATUS` claim: every
 * commitment read model anchors on that claim, so a Task with none is invisible
 * as a commitment (open / candidate / list) even though it still appears in
 * node-type, search, graph, and timeline queries — and the staleness sweep does
 * not protect it. Tasks minted before the ingestion/`createNode` guards, or
 * whose only status claim was dropped as off-vocabulary, can be in exactly that
 * state.
 *
 * This sweep finds Task nodes with NO `HAS_TASK_STATUS` claim in ANY lifecycle
 * state and assigns a default candidate-band status (`pending` /
 * `assistant_inferred`) so they surface as candidates the user can confirm or
 * dismiss. Anchoring the absence check on "any state" is the deliberate
 * carve-out that EXCLUDES dismissed tasks (status retracted) — those are left
 * to orphan pruning, not resurrected. `done`/`abandoned` tasks have an active
 * status and never match.
 *
 * Preview-then-apply (`dryRun` defaults true), additive (never deletes), and
 * idempotent — re-running heals any task a future write path leaves statusless,
 * so this serves as both the one-time backfill and an ongoing self-heal net.
 *
 * Common aliases: recover statusless tasks, backfill task status, statusless
 * commitment repair, orphan task status.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import { createClaim } from "~/lib/claim";
import {
  DEFAULT_TASK_STATUS,
  DEFAULT_TASK_STATUS_KIND,
  defaultTaskStatusStatement,
} from "~/lib/claims/default-task-status";
import { logEvent } from "~/lib/observability/log";
import {
  recoverStatuslessCommitmentsRequestSchema,
  type RecoverStatuslessCommitmentsRequest,
  type RecoverStatuslessCommitmentsResponse,
  type StatuslessTask,
} from "~/lib/schemas/recover-statusless-commitments";
import { useDatabase } from "~/utils/db";

/**
 * Find and (optionally) repair Task nodes with no `HAS_TASK_STATUS` claim.
 * Dry-run returns the candidate count and a bounded sample; apply mode creates
 * a default candidate-band status for up to `limit` of them.
 */
export async function recoverStatuslessCommitments(
  rawInput: RecoverStatuslessCommitmentsRequest,
): Promise<RecoverStatuslessCommitmentsResponse> {
  const input = recoverStatuslessCommitmentsRequestSchema.parse(rawInput);
  const db = await useDatabase();

  // Task nodes with NO HAS_TASK_STATUS claim in any lifecycle state. The
  // "any state" NOT EXISTS is the carve-out: a deliberately-dismissed task has
  // a retracted status claim in history and is therefore skipped.
  const candidatesPlusOne = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, input.userId),
        eq(nodes.nodeType, "Task"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${claims}
          WHERE ${claims.userId} = ${input.userId}
            AND ${claims.subjectNodeId} = ${nodes.id}
            AND ${claims.predicate} = 'HAS_TASK_STATUS'
        )`,
      ),
    )
    .orderBy(asc(nodes.createdAt), asc(nodes.id))
    .limit(input.limit + 1);

  const hasMore = candidatesPlusOne.length > input.limit;
  const candidates = candidatesPlusOne.slice(0, input.limit);

  let recoveredCount = 0;
  if (!input.dryRun) {
    for (const task of candidates) {
      // `createClaim` resolves the per-user manual source, validates the status
      // vocabulary, runs lifecycle, and embeds — the canonical write path. Scope
      // defaults to `personal` so the recovered task is visible as a candidate.
      await createClaim({
        userId: input.userId,
        subjectNodeId: task.id,
        predicate: "HAS_TASK_STATUS",
        statement: defaultTaskStatusStatement(task.label),
        objectValue: DEFAULT_TASK_STATUS,
        assertedByKind: DEFAULT_TASK_STATUS_KIND,
      });
      recoveredCount += 1;
    }
  }

  const sample: StatuslessTask[] = candidates
    .slice(0, input.sampleLimit)
    .map((task) => ({
      id: task.id,
      label: task.label,
      createdAt: task.createdAt,
    }));

  logEvent("commitments.statusless.recovered", {
    userId: input.userId,
    dryRun: input.dryRun,
    candidateCount: candidates.length,
    recoveredCount,
    hasMore,
  });

  return {
    dryRun: input.dryRun,
    candidateCount: candidates.length,
    recoveredCount,
    hasMore,
    candidates: sample,
  };
}
