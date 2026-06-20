/**
 * Paginated, sortable, searchable, filterable list over the full commitment
 * lifecycle. Sibling of `open-commitments.ts`, reusing its 6-table join shape
 * but selecting every status (not just open) and adding keyset pagination.
 * Common aliases: list tasks, list commitments, completed tasks, task history.
 */
import { readDueQualifier } from "./due-qualifier";
import {
  and,
  aliasedTable,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  claims,
  commitmentPresentations,
  nodeMetadata,
  nodes,
  sources,
} from "~/db/schema";
import { coerceTaskStatus } from "~/lib/claims/task-status";
import type {
  CommitmentListItem,
  CommitmentPresentation,
  CommitmentProvenance,
  CommitmentSort,
  ListCommitmentsRequest,
  ListCommitmentsResponse,
} from "~/lib/schemas/list-commitments";
import { deriveTitle } from "~/lib/sources-read";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

interface ListRow {
  taskId: TypeId<"node">;
  label: string | null;
  status: string | null;
  ownerNodeId: TypeId<"node"> | null;
  ownerLabel: string | null;
  dueOn: string | null;
  dueMetadata: unknown;
  dueInstant: Date | null;
  statusChangedAt: Date;
  createdAt: Date;
  sourceId: TypeId<"source">;
  sourceMetadata: unknown;
  sourceCreatedAt: Date | null;
  sourceLastIngestedAt: Date | null;
  presentationExcerpt: string | null;
  presentationWhy: string | null;
}

/**
 * Keyset cursor. `v` is the string-rendered sort value of the last row, `i`
 * its task id (the total-order tiebreaker). `n` flags whether that row's sort
 * value was null — only meaningful for the `dueOn`/`dueAt` sorts, where undated
 * tasks are pushed to the end regardless of `order`.
 */
interface ListCursor {
  v: string | null;
  i: string;
  n: boolean;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): ListCursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ListCursor>;
    if (
      (typeof decoded.v !== "string" && decoded.v !== null) ||
      typeof decoded.i !== "string" ||
      typeof decoded.n !== "boolean"
    ) {
      return null;
    }
    return { v: decoded.v, i: decoded.i, n: decoded.n };
  } catch {
    return null;
  }
}

/** Provenance predicate for the defining `HAS_TASK_STATUS` claim. */
function statusProvenanceFilter(
  column: typeof claims.assertedByKind,
  provenance: CommitmentProvenance,
): SQL | undefined {
  if (provenance === "candidate") return eq(column, "assistant_inferred");
  if (provenance === "trusted") return ne(column, "assistant_inferred");
  return undefined;
}

/**
 * Provenance predicate for the ASSIGNED_TO / DUE_ON sub-joins. The trusted band
 * shows only trusted metadata; candidate/all apply no constraint so a trusted
 * owner/due on a not-yet-confirmed candidate still surfaces.
 */
function subJoinProvenanceFilter(
  column: typeof claims.assertedByKind,
  provenance: CommitmentProvenance,
): SQL | undefined {
  return provenance === "trusted"
    ? ne(column, "assistant_inferred")
    : undefined;
}

/** Escape `%`, `_`, and backslash so a search term is treated as a literal. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Assemble the inbox card's inline evidence: provenance from the joined source
 * (present for every commitment with a resolvable source), plus the verbatim
 * excerpt + why when a `commitment_presentations` row exists.
 */
function buildPresentation(row: {
  sourceId: TypeId<"source">;
  sourceMetadata: unknown;
  sourceCreatedAt: Date | null;
  sourceLastIngestedAt: Date | null;
  presentationExcerpt: string | null;
  presentationWhy: string | null;
}): CommitmentPresentation {
  const source =
    row.sourceCreatedAt === null
      ? null
      : {
          sourceId: row.sourceId,
          title: deriveTitle(row.sourceMetadata),
          overheardAt: row.sourceLastIngestedAt ?? row.sourceCreatedAt,
        };
  return {
    source,
    excerpt: row.presentationExcerpt,
    why: row.presentationWhy,
  };
}

export async function listCommitments(
  params: ListCommitmentsRequest,
): Promise<ListCommitmentsResponse> {
  const {
    userId,
    statuses,
    provenance,
    ownedBy,
    unowned,
    dueBefore,
    dueAfter,
    dueBeforeInstant,
    dueAfterInstant,
    hasDueDate,
    search,
    sort,
    order,
    limit,
    cursor,
  } = params;

  const db = await useDatabase();
  const ownerClaim = aliasedTable(claims, "ownerClaim");
  const ownerMetadata = aliasedTable(nodeMetadata, "ownerMetadata");
  const dueClaim = aliasedTable(claims, "dueClaim");
  const dueMetadata = aliasedTable(nodeMetadata, "dueMetadata");

  // Map each sort key onto its underlying column for both ORDER BY and keyset.
  // Wrap each in `sql` so the record collapses to a single `SQL` value type
  // regardless of the heterogeneous source columns.
  const sortColumns: Record<CommitmentSort, SQL> = {
    statusChangedAt: sql`${claims.statedAt}`,
    createdAt: sql`${nodes.createdAt}`,
    label: sql`${nodeMetadata.label}`,
    dueOn: sql`${dueMetadata.label}`,
    dueAt: sql`${dueClaim.objectInstant}`,
  };
  const sortColumn = sortColumns[sort];
  const dir = order === "asc" ? asc : desc;
  const nullFlag =
    sort === "dueAt"
      ? sql<boolean>`(${dueClaim.objectInstant} IS NULL)`
      : sql<boolean>`(${dueMetadata.label} IS NULL)`;

  const whereClauses: (SQL | undefined)[] = [
    eq(claims.userId, userId),
    eq(claims.predicate, "HAS_TASK_STATUS"),
    eq(claims.status, "active"),
    eq(claims.scope, "personal"),
    statusProvenanceFilter(claims.assertedByKind, provenance),
    statuses === undefined || statuses.length === 0
      ? undefined
      : inArray(claims.objectValue, statuses),
    ownedBy === undefined ? undefined : eq(ownerClaim.objectNodeId, ownedBy),
    unowned === true ? isNull(ownerClaim.id) : undefined,
    dueBefore === undefined
      ? undefined
      : sql`${dueMetadata.label} <= ${dueBefore}`,
    dueAfter === undefined
      ? undefined
      : sql`${dueMetadata.label} >= ${dueAfter}`,
    dueBeforeInstant === undefined
      ? undefined
      : sql`${dueClaim.objectInstant} <= ${dueBeforeInstant.toISOString()}`,
    dueAfterInstant === undefined
      ? undefined
      : sql`${dueClaim.objectInstant} >= ${dueAfterInstant.toISOString()}`,
    hasDueDate === undefined
      ? undefined
      : hasDueDate
        ? isNotNull(dueMetadata.label)
        : isNull(dueMetadata.label),
    search === undefined
      ? undefined
      : ilike(nodeMetadata.label, `%${escapeLike(search)}%`),
  ];

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    whereClauses.push(keysetClause(sort, order, sortColumn, decoded));
  }

  // ORDER BY: for `dueOn`, push nulls last (independent of direction) before the
  // sort column, then the task id tiebreaker so the keyset is total.
  const orderBy: SQL[] =
    sort === "dueOn" || sort === "dueAt"
      ? [asc(nullFlag), dir(sortColumn), dir(nodes.id)]
      : [dir(sortColumn), dir(nodes.id)];

  const rows: ListRow[] = await db
    .select({
      taskId: nodes.id,
      label: nodeMetadata.label,
      status: claims.objectValue,
      ownerNodeId: ownerClaim.objectNodeId,
      ownerLabel: ownerMetadata.label,
      dueOn: dueMetadata.label,
      dueMetadata: dueClaim.metadata,
      dueInstant: dueClaim.objectInstant,
      statusChangedAt: claims.statedAt,
      createdAt: nodes.createdAt,
      sourceId: claims.sourceId,
      sourceMetadata: sources.metadata,
      sourceCreatedAt: sources.createdAt,
      sourceLastIngestedAt: sources.lastIngestedAt,
      presentationExcerpt: commitmentPresentations.excerpt,
      presentationWhy: commitmentPresentations.why,
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
        eq(ownerClaim.predicate, "ASSIGNED_TO"),
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
    .leftJoin(sources, eq(sources.id, claims.sourceId))
    .leftJoin(
      commitmentPresentations,
      eq(commitmentPresentations.taskId, nodes.id),
    )
    .where(and(...whereClauses.filter((c): c is SQL => c !== undefined)))
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const commitments: CommitmentListItem[] = [];
  for (const row of page) {
    // Off-vocabulary status values can reach the store via the extraction path;
    // coerce known synonyms and skip anything unmappable rather than 500 the
    // whole list (mirrors the open-commitments read model).
    const status = coerceTaskStatus(row.status);
    if (status === null) {
      console.warn(
        `Skipping Task ${row.taskId} with off-vocabulary HAS_TASK_STATUS: ${JSON.stringify(
          row.status,
        )}`,
      );
      continue;
    }
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
      statusChangedAt: row.statusChangedAt,
      createdAt: row.createdAt,
      sourceId: row.sourceId,
      presentation: buildPresentation(row),
    });
  }

  // nextCursor is derived from the last RAW page row (not the filtered list) so
  // keyset continuity holds even when a coerce-null row was skipped above.
  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1]!;
    nextCursor = encodeCursor({
      v: sortValueOf(sort, last),
      i: last.taskId,
      n:
        (sort === "dueOn" && last.dueOn === null) ||
        (sort === "dueAt" && last.dueInstant === null),
    });
  }

  return { commitments, nextCursor };
}

/** Render the active sort column's value for a row as the cursor token. */
function sortValueOf(sort: CommitmentSort, row: ListRow): string | null {
  switch (sort) {
    case "statusChangedAt":
      return row.statusChangedAt.toISOString();
    case "createdAt":
      return row.createdAt.toISOString();
    case "label":
      return row.label;
    case "dueOn":
      return row.dueOn;
    case "dueAt":
      // `object_instant` is millisecond-or-coarser (it originates from
      // `instantFromLocalTime` at HH:mm granularity), so this ISO string
      // compares exactly against the timestamptz column in the keyset `=`
      // tiebreak — no sub-millisecond precision is lost on the round-trip.
      return row.dueInstant === null ? null : row.dueInstant.toISOString();
  }
}

/**
 * Build the keyset WHERE clause that resumes strictly *after* the cursor row,
 * given the sort direction. For `dueOn`/`dueAt`, the leading `nulls last`
 * ordering term is encoded as the boundary flag `n`: once the cursor is past the
 * dated rows (`n === true`), only undated rows with a larger id remain.
 */
function keysetClause(
  sort: CommitmentSort,
  order: "asc" | "desc",
  sortColumn: SQL,
  cursor: ListCursor,
): SQL {
  const cmp = order === "asc" ? sql`>` : sql`<`;
  const idCmp =
    order === "asc"
      ? sql`${nodes.id} > ${cursor.i}`
      : sql`${nodes.id} < ${cursor.i}`;

  if (sort === "dueOn" || sort === "dueAt") {
    if (cursor.n) {
      // Cursor sits in the trailing null block: only later null rows remain.
      return and(isNull(sortColumn), idCmp)!;
    }
    // Cursor in the dated block: more dated rows past the value, OR any null row.
    return or(
      and(isNotNull(sortColumn), sql`${sortColumn} ${cmp} ${cursor.v}`),
      and(isNotNull(sortColumn), sql`${sortColumn} = ${cursor.v}`, idCmp),
      isNull(sortColumn),
    )!;
  }

  // Non-null sort keys: a plain two-term keyset.
  return or(
    sql`${sortColumn} ${cmp} ${cursor.v}`,
    and(sql`${sortColumn} = ${cursor.v}`, idCmp),
  )!;
}
