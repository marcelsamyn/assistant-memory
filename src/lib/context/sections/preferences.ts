/**
 * Preferences section assembler.
 *
 * Active personal claims for predicates whose registry policy is both
 * `feedsAtlas = true` and `retrievalSection = 'preferences'` (today:
 * HAS_PREFERENCE, HAS_GOAL). Trusted authorship only — `user` and
 * `user_confirmed`. Capped at 20.
 */
import { PREDICATE_POLICIES } from "~/lib/claims/predicate-policies";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata } from "~/db/schema";
import type { AssertedByKind, Predicate } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import type {
  ClaimEvidence,
  ContextSectionPreferences,
} from "../types";

const MAX_ROWS = 20;
const USAGE =
  "Active user preferences and goals. Treat as durable; align suggestions with these unless the user has just contradicted them.";

const TRUSTED_KINDS = [
  "user",
  "user_confirmed",
] as const satisfies readonly AssertedByKind[];

const PREFERENCE_PREDICATES: readonly Predicate[] = Object.values(
  PREDICATE_POLICIES,
)
  .filter(
    (policy) =>
      policy.feedsAtlas && policy.retrievalSection === "preferences",
  )
  .map((policy) => policy.predicate);

interface PreferenceRow {
  claimId: TypeId<"claim">;
  sourceId: TypeId<"source">;
  statement: string;
  predicate: Predicate;
  objectValue: string | null;
  subjectLabel: string | null;
}

function renderLine(row: PreferenceRow): string {
  const subject = row.subjectLabel ?? "(unlabeled)";
  const value =
    row.objectValue !== null && row.objectValue.length > 0
      ? `=${row.objectValue}`
      : "";
  return `- [${row.predicate}${value}] ${subject}: ${row.statement}`;
}

export async function assemblePreferencesSection(
  db: DrizzleDB,
  userId: string,
): Promise<ContextSectionPreferences | null> {
  if (PREFERENCE_PREDICATES.length === 0) return null;

  const rows: PreferenceRow[] = await db
    .select({
      claimId: claims.id,
      sourceId: claims.sourceId,
      statement: claims.statement,
      predicate: claims.predicate,
      objectValue: claims.objectValue,
      subjectLabel: nodeMetadata.label,
    })
    .from(claims)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, claims.subjectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, "personal"),
        eq(claims.status, "active"),
        inArray(claims.predicate, [...PREFERENCE_PREDICATES]),
        inArray(claims.assertedByKind, [...TRUSTED_KINDS]),
      ),
    )
    .orderBy(desc(claims.statedAt))
    .limit(MAX_ROWS);

  if (rows.length === 0) return null;

  const content = rows.map(renderLine).join("\n");
  const evidence: ClaimEvidence[] = rows.map((row) => ({
    claimId: row.claimId,
    sourceId: row.sourceId,
  }));

  return {
    kind: "preferences",
    content,
    usage: USAGE,
    evidence,
  };
}
