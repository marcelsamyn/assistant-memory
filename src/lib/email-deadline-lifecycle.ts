import { hasEmailDeadlineRemovalEvidence } from "./email-deadline-evidence";
import { readSourceContext } from "./email-request-extraction";
import { readCommitmentRequestEvidence } from "./schemas/commitment-request-evidence";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, sources } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

/** Find the first live removal after a deadline, including delayed mail. */
export async function findEmailDeadlineRemoval(
  db: DrizzleDB,
  userId: string,
  taskId: TypeId<"node">,
  deadlineClaimId: TypeId<"claim">,
): Promise<Pick<typeof claims.$inferSelect, "id" | "statedAt"> | undefined> {
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
  const deadline = rows.find(({ claim }) => claim.id === deadlineClaimId);
  if (!deadline) return undefined;
  const context = readSourceContext(deadline.sourceMetadata);
  if (context?.sourceKind !== "email" && context?.sourceKind !== "message")
    return undefined;

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
    return evidence.emailThread.accountId === context.accountId &&
      evidence.emailThread.threadId === context.threadId &&
      claim.statedAt > deadline.claim.statedAt
      ? [claim]
      : [];
  });
  return removals.sort(
    (a, b) => a.statedAt.getTime() - b.statedAt.getTime(),
  )[0];
}
