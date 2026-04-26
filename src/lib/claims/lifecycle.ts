/** Claim lifecycle transitions for sourced claims. */
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

type ClaimRow = typeof claims.$inferSelect;

interface StatusSubject {
  userId: string;
  subjectNodeId: TypeId<"node">;
}

function statusLifecycleSubjects(changedClaims: ClaimRow[]): StatusSubject[] {
  const subjects = new Map<string, StatusSubject>();
  for (const claim of changedClaims) {
    if (claim.predicate !== "HAS_STATUS") continue;
    const key = `${claim.userId}|${claim.subjectNodeId}`;
    subjects.set(key, {
      userId: claim.userId,
      subjectNodeId: claim.subjectNodeId,
    });
  }
  return [...subjects.values()];
}

function compareLifecycleOrder(a: ClaimRow, b: ClaimRow): number {
  const statedAtOrder = a.statedAt.getTime() - b.statedAt.getTime();
  if (statedAtOrder !== 0) return statedAtOrder;

  const createdAtOrder = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdAtOrder !== 0) return createdAtOrder;

  return a.id.localeCompare(b.id);
}

async function recomputeStatusLifecycleForSubject(
  database: DrizzleDB,
  subject: StatusSubject,
): Promise<void> {
  const statusClaims = (
    await database
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.userId, subject.userId),
          eq(claims.subjectNodeId, subject.subjectNodeId),
          eq(claims.predicate, "HAS_STATUS"),
          inArray(claims.status, ["active", "superseded"]),
        ),
      )
  ).sort(compareLifecycleOrder);

  const updatedAt = new Date();
  await Promise.all(
    statusClaims.map((claim, index) => {
      const nextClaim = statusClaims[index + 1];
      const isLatestStatus = nextClaim === undefined;
      const validFrom = claim.validFrom ?? claim.statedAt;
      const validTo = isLatestStatus
        ? claim.status === "superseded"
          ? null
          : claim.validTo
        : nextClaim.statedAt;

      return database
        .update(claims)
        .set({
          status: isLatestStatus ? "active" : "superseded",
          validFrom,
          validTo,
          updatedAt,
        })
        .where(eq(claims.id, claim.id));
    }),
  );
}

/** Apply single-valued claim lifecycle rules. Common aliases: supersession, claim lifecycle. */
export async function applyClaimLifecycle(
  database: DrizzleDB,
  changedClaims: ClaimRow[],
): Promise<void> {
  await Promise.all(
    statusLifecycleSubjects(changedClaims).map((subject) =>
      recomputeStatusLifecycleForSubject(database, subject),
    ),
  );
}

export async function fetchClaimsByIds(
  database: DrizzleDB,
  claimIds: Array<ClaimRow["id"]>,
): Promise<ClaimRow[]> {
  if (claimIds.length === 0) return [];

  return database.select().from(claims).where(inArray(claims.id, claimIds));
}
