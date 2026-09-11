import { and, eq, inArray, ne, notExists, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DrizzleDB } from "~/db";
import {
  claims,
  commitmentPresentations,
  nodes,
  sourceIngestionOperations,
  sourceLinks,
  sources,
} from "~/db/schema";
import { applyClaimLifecycle } from "~/lib/claims/lifecycle";
import {
  isEmailContext,
  readSourceContext,
} from "~/lib/email-request-extraction";
import { lockEmailRequestThread } from "~/lib/email-request-matching";
import {
  sourceContextSchema,
  type SourceContext,
} from "~/lib/schemas/source-context";
import type { Scope } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

/** Later email state is valid only while its matched request evidence exists. */
async function removeDependentEmailClaims(
  tx: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<(typeof claims.$inferSelect)[]> {
  const dependentStatuses = await tx
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        ne(claims.sourceId, sourceId),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        sql`EXISTS (SELECT 1 FROM sources WHERE sources.id = ${claims.sourceId} AND sources.type <> 'manual')`,
        sql`EXISTS (
          SELECT 1 FROM claims AS revised
          WHERE revised.user_id = ${userId}
            AND revised.source_id = ${sourceId}
            AND revised.subject_node_id = ${claims.subjectNodeId}
            AND revised.predicate = 'HAS_TASK_STATUS'
            AND (
              ${claims.metadata}->'requestEvidence'->'supportingSourceIds' ? ${sourceId}
              OR (
                ${claims.metadata}->'requestEvidence'->>'requestId' = revised.metadata->'requestEvidence'->>'requestId'
                AND ${claims.statedAt} >= revised.stated_at
              )
            )
        )`,
      ),
    );
  if (dependentStatuses.length === 0) return [];

  // Deadlines cite the same email and task as the matched status, but do not
  // store a separate request ID. Other tasks in those emails remain intact.
  return tx
    .delete(claims)
    .where(
      and(
        eq(claims.userId, userId),
        ne(claims.status, "retracted"),
        or(
          inArray(
            claims.id,
            dependentStatuses.map((claim) => claim.id),
          ),
          and(
            eq(claims.predicate, "DUE_ON"),
            or(
              ...dependentStatuses.map((claim) =>
                and(
                  eq(claims.sourceId, claim.sourceId),
                  eq(claims.subjectNodeId, claim.subjectNodeId),
                ),
              ),
            ),
          ),
        ),
      ),
    )
    .returning();
}

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

/** Caller holds the source identity gate, but has not locked source rows yet. */
export async function lockSourceEmailRequestThread(
  tx: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<void> {
  const [source] = await tx
    .select({ metadata: sources.metadata, partitionKey: sources.partitionKey })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)))
    .limit(1);
  const context = readSourceContext(source?.metadata);
  if (!source || !isEmailContext(context)) return;
  // The identity gate keeps stored context stable. Lock the old thread: the
  // incoming revision can change or remove the context being invalidated.
  await lockEmailRequestThread(
    tx,
    userId,
    source.partitionKey ?? undefined,
    context,
    sourceId,
  );
}

/** Caller holds the source lock and (for email) thread gate while replacing bytes. */
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
  // Removing an older claim must not restore a status hidden by a later
  // dismissal. The lifecycle recomputation excludes retracted claims.
  const dismissedTasks = await tx
    .selectDistinct({ taskId: claims.subjectNodeId })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.sourceId, sourceId),
        eq(claims.predicate, "HAS_TASK_STATUS"),
        sql`EXISTS (
          SELECT 1 FROM claims AS dismissed
          WHERE dismissed.subject_node_id = ${claims.subjectNodeId}
            AND dismissed.predicate = 'HAS_TASK_STATUS'
            AND dismissed.status = 'retracted'
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM claims AS current
          WHERE current.subject_node_id = ${claims.subjectNodeId}
            AND current.predicate = 'HAS_TASK_STATUS'
            AND current.status = 'active'
        )`,
      ),
    );
  const dependentClaims = await removeDependentEmailClaims(
    tx,
    userId,
    sourceId,
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
  removed.push(...dependentClaims);
  await applyClaimLifecycle(tx, removed);
  await tx
    .update(claims)
    .set({ status: "superseded", updatedAt: new Date() })
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        or(
          and(eq(claims.sourceId, sourceId), retainedRequest),
          dismissedTasks.length === 0
            ? undefined
            : and(
                eq(claims.predicate, "HAS_TASK_STATUS"),
                inArray(
                  claims.subjectNodeId,
                  dismissedTasks.map((task) => task.taskId),
                ),
              ),
        ),
      ),
    );
  const removedLinks = await tx
    .delete(sourceLinks)
    .where(
      or(
        eq(sourceLinks.sourceId, sourceId),
        ...dependentClaims.map((claim) =>
          and(
            eq(sourceLinks.sourceId, claim.sourceId),
            eq(sourceLinks.nodeId, claim.subjectNodeId),
            notExists(
              tx
                .select({ id: claims.id })
                .from(claims)
                .where(
                  and(
                    eq(claims.sourceId, sourceLinks.sourceId),
                    or(
                      eq(claims.subjectNodeId, sourceLinks.nodeId),
                      eq(claims.objectNodeId, sourceLinks.nodeId),
                      eq(claims.assertedByNodeId, sourceLinks.nodeId),
                    ),
                  ),
                ),
            ),
          ),
        ),
      ),
    )
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
