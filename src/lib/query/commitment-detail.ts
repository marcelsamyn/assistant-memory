/** Detail read model for a single commitment (current state + history + sources). */
import { readDueQualifier, type DueQualifierFields } from "./due-qualifier";
import { and, eq, inArray } from "drizzle-orm";
import { claims, sources } from "~/db/schema";
import { coerceTaskStatus } from "~/lib/claims/task-status";
import { TaskNotFoundError } from "~/lib/commitments";
import { getNodeById } from "~/lib/node";
import type {
  CommitmentSource,
  GetCommitmentRequest,
  GetCommitmentResponse,
  TaskLifecycleEntry,
} from "~/lib/schemas/get-commitment";
import { sourceMetadataSchema } from "~/lib/sources";
import { type ClaimStatus, type Predicate } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/** The three predicates that carry a Task's lifecycle. */
const TASK_PREDICATES: readonly Predicate[] = [
  "HAS_TASK_STATUS",
  "OWNED_BY",
  "DUE_ON",
];

/** Narrow a generic predicate to the lifecycle subset used by the history shape. */
function isTaskLifecyclePredicate(
  predicate: Predicate,
): predicate is TaskLifecycleEntry["predicate"] {
  return (
    predicate === "HAS_TASK_STATUS" ||
    predicate === "OWNED_BY" ||
    predicate === "DUE_ON"
  );
}

/** Best-effort source display title from its metadata (title ?? filename ?? null). */
function deriveSourceTitle(metadata: unknown): string | null {
  const parsed = sourceMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) return null;
  if (parsed.data.title) return parsed.data.title;
  const filename = (parsed.data as Record<string, unknown>)["filename"];
  return typeof filename === "string" && filename.length > 0 ? filename : null;
}

/**
 * Read a single commitment's detail model in (at most) two queries:
 * `getNodeById` for the node + full lifecycle slice of the three task
 * predicates, then one batched `inArray` over `sources` for evidence.
 *
 * Derives the current `status`/`owner`/`dueOn` from the `active` claims and
 * (when `includeHistory`) maps the rest into `history` sorted `statedAt` desc.
 * Non-Task or cross-user `taskId` → {@link TaskNotFoundError} (route → 404).
 */
export async function getCommitment(
  params: GetCommitmentRequest,
): Promise<GetCommitmentResponse> {
  const { userId, taskId, includeHistory, includeSources } = params;

  const db = await useDatabase();

  const result = await getNodeById(userId, taskId, {
    predicates: [...TASK_PREDICATES],
    statuses: [],
  });

  if (!result || result.node.nodeType !== "Task") {
    throw new TaskNotFoundError(taskId);
  }

  // Keep only claims where the task is the subject — `getNodeById` also returns
  // claims where the node is the object, which aren't part of its lifecycle.
  const taskClaims = result.claims.filter(
    (claim) => claim.subjectNodeId === taskId,
  );

  const isActive = (status: ClaimStatus): boolean => status === "active";

  const activeStatus = taskClaims.find(
    (claim) => claim.predicate === "HAS_TASK_STATUS" && isActive(claim.status),
  );
  const activeOwner = taskClaims.find(
    (claim) => claim.predicate === "OWNED_BY" && isActive(claim.status),
  );
  const activeDue = taskClaims.find(
    (claim) => claim.predicate === "DUE_ON" && isActive(claim.status),
  );

  // Coerce rather than strict-parse: an off-vocabulary active status yields
  // null (the field is nullable) instead of 500-ing the detail read.
  const status = activeStatus
    ? coerceTaskStatus(activeStatus.objectValue)
    : null;

  const owner =
    activeOwner && activeOwner.objectNodeId !== null
      ? {
          nodeId: activeOwner.objectNodeId,
          label: activeOwner.objectLabel,
          claimId: activeOwner.id,
        }
      : null;

  const history: TaskLifecycleEntry[] = includeHistory
    ? taskClaims
        .filter((claim) => isTaskLifecyclePredicate(claim.predicate))
        .map((claim) => ({
          claimId: claim.id,
          predicate: claim.predicate as TaskLifecycleEntry["predicate"],
          value: claim.objectValue ?? claim.objectLabel,
          objectNodeId: claim.objectNodeId,
          status: claim.status,
          assertedByKind: claim.assertedByKind,
          sourceId: claim.sourceId,
          statedAt: claim.statedAt,
        }))
        .sort((a, b) => b.statedAt.getTime() - a.statedAt.getTime())
    : [];

  const sourcesList = includeSources
    ? await loadSources(
        userId,
        taskClaims.map((claim) => claim.sourceId),
      )
    : [];

  let due: DueQualifierFields = { dueTime: null, timeZone: null, dueAt: null };
  if (activeDue) {
    const [dueRow] = await db
      .select({
        metadata: claims.metadata,
        objectInstant: claims.objectInstant,
      })
      .from(claims)
      .where(and(eq(claims.id, activeDue.id), eq(claims.userId, userId)))
      .limit(1);
    if (dueRow) due = readDueQualifier(dueRow.metadata, dueRow.objectInstant);
  }

  return {
    taskId,
    label: result.node.label,
    description: result.node.description,
    createdAt: result.node.createdAt,
    status,
    statusClaimId: activeStatus ? activeStatus.id : null,
    statusStatedAt: activeStatus ? activeStatus.statedAt : null,
    statusAssertedByKind: activeStatus ? activeStatus.assertedByKind : null,
    owner,
    dueOn: activeDue ? activeDue.objectLabel : null,
    dueTime: due.dueTime,
    timeZone: due.timeZone,
    dueAt: due.dueAt,
    dueClaimId: activeDue ? activeDue.id : null,
    sources: sourcesList,
    history,
  };
}

/** Batch-resolve the distinct source ids behind a task's claims. */
async function loadSources(
  userId: string,
  sourceIds: ReadonlyArray<TypeId<"source">>,
): Promise<CommitmentSource[]> {
  const distinctIds = [...new Set(sourceIds)];
  if (distinctIds.length === 0) return [];

  const db = await useDatabase();
  const rows = await db
    .select({
      id: sources.id,
      type: sources.type,
      scope: sources.scope,
      metadata: sources.metadata,
      createdAt: sources.createdAt,
      lastIngestedAt: sources.lastIngestedAt,
    })
    .from(sources)
    .where(and(inArray(sources.id, distinctIds), eq(sources.userId, userId)));

  return rows.map((row) => ({
    sourceId: row.id,
    type: row.type,
    title: deriveSourceTitle(row.metadata),
    scope: row.scope,
    ingestedAt: row.lastIngestedAt ?? row.createdAt,
  }));
}
