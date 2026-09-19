import { hasEmailDeadlineRemovalEvidence } from "./email-deadline-evidence";
import { readSourceContext } from "./email-request-extraction";
import { readCommitmentRequestEvidence } from "./schemas/commitment-request-evidence";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, sources } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

/** Reapply removal evidence after date supersession, including delayed mail. */
export async function applyEmailDeadlineRemovals(
  db: DrizzleDB,
  userId: string,
  taskId: TypeId<"node">,
): Promise<void> {
  const rows = await db
    .select({ claim: claims, sourceMetadata: sources.metadata })
    .from(claims)
    .innerJoin(sources, eq(sources.id, claims.sourceId))
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, taskId),
        inArray(claims.predicate, ["HAS_TASK_STATUS", "DUE_ON"]),
        eq(claims.assertedByKind, "assistant_inferred"),
        isNull(sources.deletedAt),
      ),
    );
  const removals = rows.flatMap(({ claim }) => {
    if (claim.predicate !== "HAS_TASK_STATUS") return [];
    const evidence = readCommitmentRequestEvidence(claim.metadata);
    if (
      evidence?.matchStatus !== "matched" ||
      evidence.lifecycleEvidence !== "current_message_revision" ||
      !evidence.emailThread ||
      !hasEmailDeadlineRemovalEvidence(evidence.emailThread.excerpt)
    )
      return [];
    return [{ claim, thread: evidence.emailThread }];
  });
  for (const { claim, sourceMetadata } of rows) {
    if (claim.predicate !== "DUE_ON" || claim.status !== "active") continue;
    const context = readSourceContext(sourceMetadata);
    if (context?.sourceKind !== "email" && context?.sourceKind !== "message")
      continue;
    const removal = removals
      .filter(
        (item) =>
          item.claim.subjectNodeId === claim.subjectNodeId &&
          item.claim.statedAt > claim.statedAt &&
          item.thread.accountId === context.accountId &&
          item.thread.threadId === context.threadId,
      )
      .sort(
        (a, b) => a.claim.statedAt.getTime() - b.claim.statedAt.getTime(),
      )[0];
    if (!removal) continue;
    // The revision claim supplies the removal's timestamp and source citation;
    // DUE_ON keeps its Temporal object and needs no invented "no date" value.
    await db
      .update(claims)
      .set({
        status: "superseded",
        validTo: removal.claim.statedAt,
        supersededByClaimId: removal.claim.id,
        updatedAt: new Date(),
      })
      .where(and(eq(claims.id, claim.id), eq(claims.status, "active")));
  }
}
