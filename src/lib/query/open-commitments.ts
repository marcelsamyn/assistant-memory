import { and, desc, eq, isNotNull, ne, aliasedTable } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import {
  type OpenCommitment,
  type OpenCommitmentsRequest,
} from "~/lib/schemas/open-commitments";
import { TaskStatusEnum, type TaskStatus } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface OpenCommitmentRow {
  taskId: TypeId<"node">;
  label: string | null;
  status: string | null;
  ownerNodeId: TypeId<"node"> | null;
  ownerLabel: string | null;
  dueOn: string | null;
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

/** List lifecycle-current open Task nodes. Common aliases: open tasks, commitments, todos. */
export async function getOpenCommitments(
  params: OpenCommitmentsRequest,
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
        ne(ownerClaim.assertedByKind, "assistant_inferred"),
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
        ne(dueClaim.assertedByKind, "assistant_inferred"),
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
        ne(claims.assertedByKind, "assistant_inferred"),
        ownedBy === undefined
          ? undefined
          : eq(ownerClaim.objectNodeId, ownedBy),
      ),
    )
    // Newest-wins dedupe across (taskId) is a runtime guard: OWNED_BY/DUE_ON
    // are policy-typed `multi_value` globally (legitimate co-ownership on
    // atlas etc.), but Tasks need single-current-value semantics. The policy
    // registry has no `(predicate, subjectType)` axis yet — tracked for Phase 3.
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

    const status = TaskStatusEnum.parse(row.status);
    if (!isOpenTaskStatus(status)) continue;
    if (!matchesDueBefore(row.dueOn, dueBefore)) continue;

    commitments.push({
      taskId: row.taskId,
      label: row.label,
      status,
      owner:
        row.ownerNodeId === null
          ? null
          : { nodeId: row.ownerNodeId, label: row.ownerLabel },
      dueOn: row.dueOn,
      statedAt: row.statedAt,
      sourceId: row.sourceId,
    });
  }

  return commitments;
}
