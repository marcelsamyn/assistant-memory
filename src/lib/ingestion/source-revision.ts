import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DrizzleDB } from "~/db";
import {
  claims,
  commitmentPresentations,
  nodes,
  sourceIngestionOperations,
  sourceLinks,
} from "~/db/schema";
import { applyClaimLifecycle } from "~/lib/claims/lifecycle";
import {
  sourceContextSchema,
  type SourceContext,
} from "~/lib/schemas/source-context";
import type { Scope } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

/** Internal receipt key; the supplied content hash remains a hash of bytes. */
export function hashSourceExtractionRevision(
  contentHash: string,
  sourceContext: SourceContext | undefined,
  extraction?: {
    scope: Scope;
    contentType: string;
    author?: string | undefined;
    timestamp: Date;
  },
): string {
  if (sourceContext === undefined && extraction === undefined)
    return contentHash;
  // Schema order makes equivalent JSON object key orders deterministic. URLs
  // are display metadata; the compatibility partition hint is not provenance.
  const context =
    sourceContext === undefined
      ? undefined
      : sourceContextSchema.parse(sourceContext);
  return createHash("sha256")
    .update(
      JSON.stringify({
        contentHash,
        extraction,
        context:
          context === undefined
            ? undefined
            : {
                ...context,
                sourceUrl: undefined,
                parentPartitionKey: undefined,
              },
      }),
    )
    .digest("hex");
}

/** Caller holds the source lock and commits replacement bytes in this transaction. */
export async function invalidateSourceExtractionRevision(
  tx: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<void> {
  // Only the current revision owns the deduplication key. Returning A→B→A
  // must extract A again, while historical receipts remain readable by ID.
  await tx
    .update(sourceIngestionOperations)
    .set({ contentHash: null })
    .where(
      and(
        eq(sourceIngestionOperations.userId, userId),
        eq(sourceIngestionOperations.sourceId, sourceId),
      ),
    );
  // Explicit actions use a manual source, while dismissal retracts the sourced
  // request itself. Keep that history (and confirmed request identity) so a
  // later context correction cannot undo the user's decision or duplicate it.
  const hasUserDecision = sql`EXISTS (
    SELECT 1 FROM claims AS decision
    JOIN sources AS decision_source ON decision_source.id = decision.source_id
    WHERE decision.user_id = ${claims.userId}
      AND decision.subject_node_id = ${claims.subjectNodeId}
      AND decision.predicate = 'HAS_TASK_STATUS'
      AND decision.asserted_by_kind IN ('user', 'user_confirmed')
      AND decision_source.type = 'manual'
  )`;
  const retainedRequest = and(
    eq(claims.predicate, "HAS_TASK_STATUS"),
    hasUserDecision,
  );
  await tx
    .update(claims)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.sourceId, sourceId),
        eq(claims.status, "active"),
        retainedRequest,
      ),
    );
  const removed = await tx
    .delete(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.sourceId, sourceId),
        ne(claims.status, "retracted"),
        sql`NOT (${retainedRequest})`,
      ),
    )
    .returning();
  await applyClaimLifecycle(tx, removed);
  const removedLinks = await tx
    .delete(sourceLinks)
    .where(eq(sourceLinks.sourceId, sourceId))
    .returning({ nodeId: sourceLinks.nodeId });
  await tx
    .delete(commitmentPresentations)
    .where(
      and(
        eq(commitmentPresentations.userId, userId),
        eq(commitmentPresentations.sourceId, sourceId),
      ),
    );

  // Claims can be a node's only provenance, including object and participant
  // references. Restrict cleanup to this revision's former evidence paths.
  const candidateIds = [
    ...new Set([
      ...removedLinks.map((link) => link.nodeId),
      ...removed.flatMap((claim) =>
        [
          claim.subjectNodeId,
          claim.objectNodeId,
          claim.assertedByNodeId,
        ].filter((nodeId): nodeId is TypeId<"node"> => nodeId !== null),
      ),
    ]),
  ];
  if (candidateIds.length === 0) return;

  // Lock before the evidence check so a concurrently committed source link or
  // claim is visible before deletion. FK inserts wait on these same row locks.
  await tx
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, candidateIds)))
    .orderBy(nodes.id)
    .for("update");
  // Metadata, embeddings, aliases, and presentations cascade with the node.
  // Retained decisions and support from other sources keep shared nodes alive.
  await tx.delete(nodes).where(
    and(
      eq(nodes.userId, userId),
      inArray(nodes.id, candidateIds),
      notExists(
        tx
          .select({ id: sourceLinks.id })
          .from(sourceLinks)
          .where(eq(sourceLinks.nodeId, nodes.id)),
      ),
      notExists(
        tx
          .select({ id: claims.id })
          .from(claims)
          .where(
            or(
              eq(claims.subjectNodeId, nodes.id),
              eq(claims.objectNodeId, nodes.id),
              eq(claims.assertedByNodeId, nodes.id),
            ),
          ),
      ),
    ),
  );
}
