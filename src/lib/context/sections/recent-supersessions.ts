/**
 * Recent supersessions section assembler.
 *
 * Lists claims that transitioned out of `active` in the last 24 hours for
 * predicates with `forceRefreshOnSupersede = true` (per the predicate
 * registry). Used as one bootstrap cycle of acknowledgment material so the
 * assistant doesn't re-prompt completed/invalidated work.
 *
 * Filters: personal scope, asserted by `user`/`user_confirmed`/`system`
 * (we explicitly drop `assistant_inferred` and third-party `participant`/
 * `document_author` per the design's "trusted lines only" rule).
 *
 * Capped at 20 rows by `updatedAt` desc.
 */
import { FORCE_REFRESH_PREDICATES } from "~/lib/jobs/atlas-invalidation";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata } from "~/db/schema";
import type { AssertedByKind, ClaimStatus } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import type {
  ClaimEvidence,
  ContextSectionRecentSupersessions,
} from "../types";

const RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_ROWS = 20;
const USAGE =
  "Recently completed or invalidated. Do not re-prompt these as pending or current.";

const TRUSTED_KINDS = [
  "user",
  "user_confirmed",
  "system",
] as const satisfies readonly AssertedByKind[];

const RECENT_STATUSES = [
  "superseded",
  "contradicted",
  "retracted",
] as const satisfies readonly ClaimStatus[];

interface RecentRow {
  claimId: TypeId<"claim">;
  sourceId: TypeId<"source">;
  statement: string;
  status: ClaimStatus;
  subjectLabel: string | null;
}

function renderLine(row: RecentRow): string {
  const subject = row.subjectLabel ?? "(unlabeled)";
  return `- ${subject}: ${row.statement} [${row.status}]`;
}

export async function assembleRecentSupersessionsSection(
  db: DrizzleDB,
  userId: string,
  asOf: Date,
): Promise<ContextSectionRecentSupersessions | null> {
  if (FORCE_REFRESH_PREDICATES.length === 0) return null;
  const since = new Date(asOf.getTime() - RECENT_WINDOW_MS);

  const rows: RecentRow[] = await db
    .select({
      claimId: claims.id,
      sourceId: claims.sourceId,
      statement: claims.statement,
      status: claims.status,
      subjectLabel: nodeMetadata.label,
    })
    .from(claims)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, claims.subjectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "personal"),
        inArray(claims.predicate, [...FORCE_REFRESH_PREDICATES]),
        inArray(claims.status, [...RECENT_STATUSES]),
        inArray(claims.assertedByKind, [...TRUSTED_KINDS]),
        gte(claims.updatedAt, since),
      ),
    )
    .orderBy(desc(claims.updatedAt))
    .limit(MAX_ROWS);

  if (rows.length === 0) return null;

  const content = rows.map(renderLine).join("\n");
  const evidence: ClaimEvidence[] = rows.map((row) => ({
    claimId: row.claimId,
    sourceId: row.sourceId,
  }));

  return {
    kind: "recent_supersessions",
    content,
    usage: USAGE,
    evidence,
  };
}
