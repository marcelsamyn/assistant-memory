import { readDueQualifier } from "./due-qualifier";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  ne,
  aliasedTable,
  sql,
} from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import { coerceTaskStatus } from "~/lib/claims/task-status";
import {
  type OpenCommitment,
  type OpenCommitmentsRequest,
} from "~/lib/schemas/open-commitments";
import { type TaskStatus } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ONLY_SQL_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$";
const OPEN_TASK_STATUSES: OpenCommitment["status"][] = [
  "pending",
  "in_progress",
];

interface OpenCommitmentRow {
  taskId: TypeId<"node">;
  label: string | null;
  status: string | null;
  ownerNodeId: TypeId<"node"> | null;
  ownerLabel: string | null;
  dueOn: string | null;
  dueMetadata: unknown;
  dueInstant: Date | null;
  statedAt: Date;
  sourceId: TypeId<"source">;
}

function matchesDueBefore(
  dueOn: string | null,
  dueBefore: string | undefined,
): boolean {
  if (dueBefore === undefined) return true;
  return dueOn !== null && DATE_ONLY_PATTERN.test(dueOn) && dueOn <= dueBefore;
}

function isOpenTaskStatus(
  status: TaskStatus,
): status is OpenCommitment["status"] {
  return status === "pending" || status === "in_progress";
}

/**
 * Which provenance band of Task statuses to return:
 * - `"trusted"` — every kind EXCEPT `assistant_inferred` (the open-commitments
 *   view the assistant and user act on).
 * - `"candidate"` — ONLY `assistant_inferred` (unconfirmed tasks awaiting
 *   confirmation; hidden from the trusted view).
 */
type CommitmentProvenance = "trusted" | "candidate";

/**
 * Provenance predicate for the *defining* `HAS_TASK_STATUS` claim — this is
 * what splits the two bands: candidate = inferred status, trusted = everything
 * else.
 */
function provenanceFilter(
  column: typeof claims.assertedByKind,
  provenance: CommitmentProvenance,
) {
  return provenance === "candidate"
    ? eq(column, "assistant_inferred")
    : ne(column, "assistant_inferred");
}

/**
 * Provenance predicate for the OWNED_BY / DUE_ON metadata sub-joins, which is
 * NOT symmetric with the status filter. The trusted view shows only trusted
 * metadata (excludes inferred). The candidate view applies NO provenance
 * constraint, so a *trusted* owner/due set on a not-yet-confirmed candidate
 * (e.g. via `setCommitmentDue`) still surfaces rather than being hidden behind
 * an `assistant_inferred`-only match.
 */
function subJoinProvenanceFilter(
  column: typeof claims.assertedByKind,
  provenance: CommitmentProvenance,
) {
  return provenance === "trusted"
    ? ne(column, "assistant_inferred")
    : undefined;
}

/** List lifecycle-current open Task nodes. Common aliases: open tasks, commitments, todos. */
export async function getOpenCommitments(
  params: OpenCommitmentsRequest,
): Promise<OpenCommitment[]> {
  return queryCommitments(params, "trusted");
}

/**
 * List lifecycle-current *candidate* Task nodes — open tasks whose latest
 * trusted-band status is `assistant_inferred`, i.e. the extractor proposed
 * them but the user hasn't confirmed. Surfaced for proactive confirmation;
 * deliberately excluded from {@link getOpenCommitments}. Common aliases:
 * candidate commitments, inferred tasks, unconfirmed tasks, tasks to confirm.
 */
export async function getCandidateCommitments(
  params: OpenCommitmentsRequest,
): Promise<OpenCommitment[]> {
  return queryCommitments(params, "candidate");
}

async function queryCommitments(
  params: OpenCommitmentsRequest,
  provenance: CommitmentProvenance,
): Promise<OpenCommitment[]> {
  const { userId, ownedBy, dueBefore } = params;
  const db = await useDatabase();
  const ownerClaim = aliasedTable(claims, "ownerClaim");
  const ownerMetadata = aliasedTable(nodeMetadata, "ownerMetadata");
  const dueClaim = aliasedTable(claims, "dueClaim");
  const dueMetadata = aliasedTable(nodeMetadata, "dueMetadata");

  const rows: OpenCommitmentRow[] = await db
    .select({
      taskId: nodes.id,
      label: nodeMetadata.label,
      status: claims.objectValue,
      ownerNodeId: ownerClaim.objectNodeId,
      ownerLabel: ownerMetadata.label,
      dueOn: dueMetadata.label,
      dueMetadata: dueClaim.metadata,
      dueInstant: dueClaim.objectInstant,
      statedAt: claims.statedAt,
      sourceId: claims.sourceId,
    })
    .from(claims)
    .innerJoin(
      nodes,
      and(
        eq(nodes.id, claims.subjectNodeId),
        eq(nodes.userId, userId),
        eq(nodes.nodeType, "Task"),
      ),
    )
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(
      ownerClaim,
      and(
        eq(ownerClaim.userId, userId),
        eq(ownerClaim.subjectNodeId, nodes.id),
        eq(ownerClaim.predicate, "OWNED_BY"),
        eq(ownerClaim.status, "active"),
        eq(ownerClaim.scope, "personal"),
        subJoinProvenanceFilter(ownerClaim.assertedByKind, provenance),
        isNotNull(ownerClaim.objectNodeId),
      ),
    )
    .leftJoin(ownerMetadata, eq(ownerMetadata.nodeId, ownerClaim.objectNodeId))
    .leftJoin(
      dueClaim,
      and(
        eq(dueClaim.userId, userId),
        eq(dueClaim.subjectNodeId, nodes.id),
        eq(dueClaim.predicate, "DUE_ON"),
        eq(dueClaim.status, "active"),
        eq(dueClaim.scope, "personal"),
        subJoinProvenanceFilter(dueClaim.assertedByKind, provenance),
        isNotNull(dueClaim.objectNodeId),
      ),
    )
    .leftJoin(dueMetadata, eq(dueMetadata.nodeId, dueClaim.objectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        eq(claims.status, "active"),
        eq(claims.scope, "personal"),
        provenanceFilter(claims.assertedByKind, provenance),
        inArray(claims.objectValue, OPEN_TASK_STATUSES),
        ownedBy === undefined
          ? undefined
          : eq(ownerClaim.objectNodeId, ownedBy),
        dueBefore === undefined
          ? undefined
          : and(
              isNotNull(dueMetadata.label),
              sql`${dueMetadata.label} ~ ${DATE_ONLY_SQL_PATTERN}`,
              lte(dueMetadata.label, dueBefore),
            ),
      ),
    )
    // Belt-and-suspenders newest-wins dedupe across (taskId): supersession
    // for OWNED_BY/DUE_ON on Tasks is now enforced at the lifecycle engine
    // via `subjectTypeOverrides` in the predicate registry, so production
    // claims should already be single-active. We keep this dedupe so claims
    // written before the override landed (or any backfill gap) don't leak
    // duplicate rows into the read model.
    .orderBy(
      desc(claims.statedAt),
      desc(claims.createdAt),
      desc(ownerClaim.statedAt),
      desc(dueClaim.statedAt),
    );

  const commitments: OpenCommitment[] = [];
  const seenTaskIds = new Set<string>();

  for (const row of rows) {
    if (seenTaskIds.has(row.taskId)) continue;
    seenTaskIds.add(row.taskId);

    // Off-vocabulary status values can reach the store via the extraction
    // path (the LLM doesn't always honor the enum), so coerce known synonyms
    // and skip anything genuinely unmappable. A single bad row must not 500
    // the whole read — see `coerceTaskStatus`.
    const status = coerceTaskStatus(row.status);
    if (status === null) {
      console.warn(
        `Skipping Task ${row.taskId} with off-vocabulary HAS_TASK_STATUS: ${JSON.stringify(
          row.status,
        )}`,
      );
      continue;
    }
    if (!isOpenTaskStatus(status)) continue;
    if (!matchesDueBefore(row.dueOn, dueBefore)) continue;

    const due = readDueQualifier(row.dueMetadata, row.dueInstant);
    commitments.push({
      taskId: row.taskId,
      label: row.label,
      status,
      owner:
        row.ownerNodeId === null
          ? null
          : { nodeId: row.ownerNodeId, label: row.ownerLabel },
      dueOn: row.dueOn,
      dueTime: due.dueTime,
      timeZone: due.timeZone,
      dueAt: due.dueAt,
      statedAt: row.statedAt,
      sourceId: row.sourceId,
    });
  }

  return commitments;
}
