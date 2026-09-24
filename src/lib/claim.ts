/** Claim operations: create, retract, delete, reattribute. */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { claims, nodeMetadata, nodes } from "~/db/schema";
import { applyClaimLifecycle, fetchClaimsByIds } from "~/lib/claims/lifecycle";
import { assertRelationshipPredicateShape } from "~/lib/claims/predicate-shapes";
import {
  EMBED_CLAIM_JOB_OPTIONS,
  type EmbedClaimJobInput,
} from "~/lib/jobs/embed-claim";
import { CrossScopeMergeError } from "~/lib/node";
import { getEffectiveNodeScopes } from "~/lib/node-scope";
import { logEvent } from "~/lib/observability/log";
import {
  assertPartitionReadAllowed,
  assertSourcePartition,
  preparePartitionWrite,
  withSourceWriteFence,
} from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
import { ensureSystemSource } from "~/lib/sources";
import {
  AttributePredicateEnum,
  RelationshipPredicateEnum,
  TaskStatusEnum,
  type AssertedByKind,
  type ClaimStatus,
  type NodeType,
  type Predicate,
  type ReattributeReplace,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

type Database = Awaited<ReturnType<typeof useDatabase>>;

export interface ClaimPartitionResolution {
  found: boolean;
  partitionKey: ContextPartitionKey | undefined;
}

/** Resolve an existing claim's concrete partition before a strict mutation. */
export async function resolveClaimPartition(
  db: Database,
  userId: string,
  claimId: TypeId<"claim">,
  partitionKey: ContextPartitionKey | undefined,
  accessScope: MemoryAccessScope = "partition",
): Promise<ClaimPartitionResolution> {
  if (accessScope !== "workspace" || partitionKey !== undefined) {
    return { found: true, partitionKey };
  }

  const [claim] = await db
    .select({ partitionKey: claims.partitionKey })
    .from(claims)
    .where(and(eq(claims.userId, userId), eq(claims.id, claimId)))
    .limit(1);
  if (!claim) return { found: false, partitionKey: undefined };
  if (claim.partitionKey !== null) {
    await assertPartitionReadAllowed(db, userId, claim.partitionKey);
  }
  return { found: true, partitionKey: claim.partitionKey ?? undefined };
}

export type ClaimSelect = typeof claims.$inferSelect;

/**
 * Thrown when an attribute claim's `objectValue` doesn't match the canonical
 * vocabulary for its predicate (e.g. `HAS_TASK_STATUS` outside `TaskStatusEnum`).
 * Routes translate this into a 400 so SDK callers can surface a structured
 * error instead of relying on string-matching the message.
 */
export class InvalidObjectValueError extends Error {
  readonly predicate: Predicate;
  readonly objectValue: string;
  readonly allowedValues: ReadonlyArray<string>;
  constructor(
    predicate: Predicate,
    objectValue: string,
    allowedValues: ReadonlyArray<string>,
  ) {
    super(
      `Invalid objectValue "${objectValue}" for predicate ${predicate}; allowed: ${allowedValues.join(", ")}`,
    );
    this.name = "InvalidObjectValueError";
    this.predicate = predicate;
    this.objectValue = objectValue;
    this.allowedValues = allowedValues;
  }
}

/**
 * Thrown when a claim's predicate does not match its object representation:
 * attribute predicates require `objectValue`, relationship predicates require
 * `objectNodeId`.
 */
export class InvalidPredicateObjectShapeError extends Error {
  readonly predicate: Predicate;
  readonly expected: "objectValue" | "objectNodeId";
  constructor(predicate: Predicate, expected: "objectValue" | "objectNodeId") {
    super(`Predicate ${predicate} requires ${expected}`);
    this.name = "InvalidPredicateObjectShapeError";
    this.predicate = predicate;
    this.expected = expected;
  }
}

/**
 * Thrown when a claim references node ids that either don't exist or aren't
 * owned by the asserting `userId`. Carries the exact set of missing ids so
 * route handlers can surface a structured response instead of a string-match
 * over the message, and callers (including the assistant) can see which
 * subject/object they got wrong rather than retrying blindly.
 */
export class NodesNotFoundError extends Error {
  readonly userId: string;
  readonly missingNodeIds: ReadonlyArray<TypeId<"node">>;
  constructor(userId: string, missingNodeIds: ReadonlyArray<TypeId<"node">>) {
    super(
      `Nodes not found or not owned by user ${userId}: ${missingNodeIds.join(", ")}`,
    );
    this.name = "NodesNotFoundError";
    this.userId = userId;
    this.missingNodeIds = missingNodeIds;
  }
}

export type CreatedClaim = ClaimSelect & {
  subjectLabel: string | null;
  objectLabel: string | null;
};

export type CreateClaimInput = {
  userId: string;
  partitionKey?: ContextPartitionKey | undefined;
  subjectNodeId: TypeId<"node">;
  predicate: Predicate;
  statement: string;
  sourceId?: TypeId<"source"> | undefined;
  objectNodeId?: TypeId<"node"> | undefined;
  objectValue?: string | undefined;
  description?: string | undefined;
  statedAt?: Date | undefined;
  validFrom?: Date | undefined;
  validTo?: Date | undefined;
  /**
   * Provenance kind. Defaults to `"user"` to preserve the historical
   * manual-API contract. Trusted clients (with their own auth/UX context)
   * may pass `"user_confirmed"` or `"assistant_inferred"` to record more
   * precise provenance; system callers (cleanup, dream synthesis, etc.)
   * pass `"system"`.
   */
  assertedByKind?: AssertedByKind | undefined;
  /**
   * Optional pointer to the participant/node that made the assertion. Only
   * meaningful when `assertedByKind` is `"participant"` or `"document_author"`;
   * for typical user/assistant claims, leave undefined.
   */
  assertedByNodeId?: TypeId<"node"> | undefined;
  /**
   * Defaults to `"personal"`. System callers that derive scope from a source
   * (e.g. `add_claim` cleanup op) pass this through.
   */
  scope?: Scope | undefined;
  /**
   * Optional jsonb payload stored on the claim. Used for predicate-specific
   * qualifiers (e.g. a `DUE_ON` claim's `{ dueTime, timeZone }`). Opaque here —
   * callers own the shape and validate it at their boundary.
   */
  metadata?: Record<string, unknown> | undefined;
  /**
   * Optional resolved UTC instant for a time-qualified temporal-object claim
   * (persisted to `claims.object_instant`). NULL/undefined for date-only claims.
   */
  objectInstant?: Date | undefined;
};

/** Generate claim embedding text independent of node labels. */
export function claimEmbeddingText(claim: {
  predicate: Predicate;
  statement: string;
  status: ClaimStatus;
  statedAt: Date;
}): string {
  return `${claim.predicate} ${claim.statement} status=${claim.status} statedAt=${claim.statedAt.toISOString()}`;
}

async function fetchOwnedNodes(
  db: Database,
  userId: string,
  nodeIds: TypeId<"node">[],
  partitionKey?: ContextPartitionKey,
): Promise<Map<TypeId<"node">, { label: string | null; nodeType: NodeType }>> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) return new Map();

  const found = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
      nodeType: nodes.nodeType,
    })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        partitionKey === undefined
          ? isNull(nodes.partitionKey)
          : eq(nodes.partitionKey, partitionKey),
        inArray(nodes.id, uniqueNodeIds),
      ),
    );

  if (found.length !== uniqueNodeIds.length) {
    const foundIds = new Set(found.map((node) => node.id));
    const missing = uniqueNodeIds.filter((id) => !foundIds.has(id));
    throw new NodesNotFoundError(userId, missing);
  }

  return new Map(
    found.map((node) => [
      node.id,
      { label: node.label ?? null, nodeType: node.nodeType },
    ]),
  );
}

/**
 * Queue the search embedding so a claim write does not wait on the external
 * embedding API. The text is captured now, so the stored vector matches the
 * claim as written even if its lifecycle status changes before the job runs.
 */
async function enqueueClaimEmbedding(
  claim: Pick<
    ClaimSelect,
    "id" | "userId" | "predicate" | "statement" | "status" | "statedAt"
  >,
): Promise<void> {
  if (shouldSkipEmbeddingPersistence()) return;

  const { batchQueue } = await import("./queues");
  await batchQueue.add(
    "embed-claim",
    {
      userId: claim.userId,
      claimId: claim.id,
      text: claimEmbeddingText(claim),
    } satisfies EmbedClaimJobInput,
    { jobId: `embed-claim:${claim.id}`, ...EMBED_CLAIM_JOB_OPTIONS },
  );
}

/** Create a sourced claim. Uses the per-user manual source when sourceId is omitted. */
export async function createClaim(
  input: CreateClaimInput,
): Promise<CreatedClaim> {
  const db = await useDatabase();
  await preparePartitionWrite(db, input.userId, input.partitionKey);
  const hasObjectNode = input.objectNodeId !== undefined;
  const hasObjectValue = input.objectValue !== undefined;
  if (hasObjectNode === hasObjectValue) {
    throw new Error("Exactly one of objectNodeId or objectValue is required");
  }

  const relationshipPredicate = RelationshipPredicateEnum.safeParse(
    input.predicate,
  );
  const attributePredicate = AttributePredicateEnum.safeParse(input.predicate);
  if (relationshipPredicate.success && !hasObjectNode) {
    throw new InvalidPredicateObjectShapeError(input.predicate, "objectNodeId");
  }
  if (attributePredicate.success && !hasObjectValue) {
    throw new InvalidPredicateObjectShapeError(input.predicate, "objectValue");
  }

  // HAS_TASK_STATUS carries a canonical vocabulary that the open-commitments
  // read model relies on. Reject anything outside `TaskStatusEnum` at the
  // write boundary so different SDK consumers can't drift apart on labels
  // ("done" vs "completed" vs "complete").
  if (
    input.predicate === "HAS_TASK_STATUS" &&
    input.objectValue !== undefined
  ) {
    const parsed = TaskStatusEnum.safeParse(input.objectValue);
    if (!parsed.success) {
      throw new InvalidObjectValueError(
        input.predicate,
        input.objectValue,
        TaskStatusEnum.options,
      );
    }
  }

  const ownedNodes = await fetchOwnedNodes(
    db,
    input.userId,
    [
      input.subjectNodeId,
      ...(input.objectNodeId !== undefined ? [input.objectNodeId] : []),
      ...(input.assertedByNodeId !== undefined ? [input.assertedByNodeId] : []),
    ],
    input.partitionKey,
  );

  if (relationshipPredicate.success && input.objectNodeId !== undefined) {
    const subject = ownedNodes.get(input.subjectNodeId);
    const object = ownedNodes.get(input.objectNodeId);
    if (subject && object) {
      assertRelationshipPredicateShape({
        predicate: relationshipPredicate.data,
        subjectType: subject.nodeType,
        objectType: object.nodeType,
      });
    }
  }

  const sourceId =
    input.sourceId ??
    (await ensureSystemSource(db, input.userId, "manual", input.partitionKey));
  await assertSourcePartition({
    db,
    userId: input.userId,
    sourceId,
    partitionKey: input.partitionKey,
  });

  const [inserted] = await withSourceWriteFence(
    db,
    {
      userId: input.userId,
      partitionKey: input.partitionKey,
      sources: [{ sourceId }],
    },
    (tx) =>
      tx
        .insert(claims)
        .values({
          userId: input.userId,
          partitionKey: input.partitionKey,
          subjectNodeId: input.subjectNodeId,
          objectNodeId: input.objectNodeId,
          objectValue: input.objectValue,
          predicate: input.predicate,
          statement: input.statement,
          description: input.description,
          metadata: input.metadata,
          objectInstant: input.objectInstant,
          sourceId,
          scope: input.scope ?? "personal",
          assertedByKind: input.assertedByKind ?? "user",
          assertedByNodeId: input.assertedByNodeId,
          statedAt: input.statedAt ?? new Date(),
          validFrom: input.validFrom,
          validTo: input.validTo,
          status: "active",
        })
        .returning(),
  );

  if (!inserted) throw new Error("Failed to create claim");

  logEvent("claim.inserted", {
    claimId: inserted.id,
    userId: inserted.userId,
    predicate: inserted.predicate,
    kind: inserted.assertedByKind,
    scope: inserted.scope,
    subjectNodeId: inserted.subjectNodeId,
  });

  const lifecycleStartedAt = new Date();
  await applyClaimLifecycle(db, [inserted]);
  const { maybeEnqueueAtlasInvalidation } = await import(
    "./jobs/atlas-invalidation"
  );
  await maybeEnqueueAtlasInvalidation(
    db,
    input.userId,
    lifecycleStartedAt,
    input.partitionKey,
  );
  const [finalized] = await fetchClaimsByIds(db, [inserted.id]);
  if (!finalized) throw new Error("Failed to fetch created claim");

  await enqueueClaimEmbedding(finalized);
  return {
    ...finalized,
    subjectLabel: ownedNodes.get(input.subjectNodeId)?.label ?? null,
    objectLabel:
      input.objectNodeId !== undefined
        ? (ownedNodes.get(input.objectNodeId)?.label ?? null)
        : null,
  };
}

/** Hard-delete a claim by ID. */
export async function deleteClaim(
  userId: string,
  claimId: TypeId<"claim">,
  partitionKey?: ContextPartitionKey,
): Promise<boolean> {
  const db = await useDatabase();
  await preparePartitionWrite(db, userId, partitionKey);
  const [deletedClaim] = await db
    .delete(claims)
    .where(
      and(
        eq(claims.id, claimId),
        eq(claims.userId, userId),
        partitionKey === undefined
          ? isNull(claims.partitionKey)
          : eq(claims.partitionKey, partitionKey),
      ),
    )
    .returning();

  if (!deletedClaim) return false;

  const lifecycleStartedAt = new Date();
  await applyClaimLifecycle(db, [deletedClaim]);
  const { maybeEnqueueAtlasInvalidation } = await import(
    "./jobs/atlas-invalidation"
  );
  await maybeEnqueueAtlasInvalidation(db, userId, lifecycleStartedAt);
  return true;
}

/**
 * Thrown when a re-attribution targets the object endpoint of an attribute
 * claim (one with a scalar `objectValue` and no `objectNodeId`). Such claims
 * have no object node to swap, so the operation is structurally invalid.
 * Routes translate this into a 400 so callers get a structured error instead
 * of string-matching the message.
 */
export class AttributeClaimObjectReattributionError extends Error {
  readonly claimId: TypeId<"claim">;
  readonly predicate: Predicate;
  constructor(claimId: TypeId<"claim">, predicate: Predicate) {
    super(
      `Claim ${claimId} (${predicate}) is an attribute claim with no object node; cannot reattribute its object endpoint`,
    );
    this.name = "AttributeClaimObjectReattributionError";
    this.claimId = claimId;
    this.predicate = predicate;
  }
}

/**
 * Thrown when a re-attribution targets a claim that is no longer active
 * (retracted/superseded/contradicted). Reattributing such a claim would
 * redundantly re-retract dead history AND mint a fresh active claim,
 * resurrecting an assertion the lifecycle already settled. Routes translate
 * this into a 409 (state conflict, same family as {@link CrossScopeMergeError})
 * so callers get a structured error instead of string-matching the message.
 */
export class InactiveClaimReattributionError extends Error {
  readonly claimId: TypeId<"claim">;
  readonly status: ClaimStatus;
  constructor(claimId: TypeId<"claim">, status: ClaimStatus) {
    super(
      `Claim ${claimId} is ${status}, not active; only active claims can be reattributed`,
    );
    this.name = "InactiveClaimReattributionError";
    this.claimId = claimId;
    this.status = status;
  }
}

export type ReattributeClaimInput = {
  userId: string;
  partitionKey?: ContextPartitionKey | undefined;
  claimId: TypeId<"claim">;
  replace: ReattributeReplace;
  newNodeId: TypeId<"node">;
};

/**
 * Atomically re-point one endpoint of a claim at a different node. The original
 * claim is retracted (never hard-deleted, so history stays visible) and a new
 * claim is created that preserves every other field — predicate, statement,
 * objectValue, description, sourceId, scope, validity window — with only the
 * chosen endpoint swapped. The new claim's provenance is recorded as
 * `user_confirmed`; when the subject is replaced, `assertedByNodeId` is set to
 * the new subject (mirroring how merge rewires subject-anchored provenance).
 *
 * `replace: "object"` is only valid for relational claims that already carry an
 * `objectNodeId`; attribute claims (scalar `objectValue`) reject it with
 * {@link AttributeClaimObjectReattributionError}. The new endpoint node must
 * exist and belong to the user (else {@link NodesNotFoundError}), and the
 * resulting (subject, object) scope pair must be uniform — a personal/reference
 * mix is refused with {@link CrossScopeMergeError}, the same guard merge uses.
 *
 * Only active originals are eligible: a non-active claim
 * (retracted/superseded/contradicted) is rejected with
 * {@link InactiveClaimReattributionError} rather than re-retracted and cloned.
 *
 * Returns the newly created claim in the same shape as {@link createClaim};
 * resolves `null` when the original claim does not exist for the user.
 */
export async function reattributeClaim(
  input: ReattributeClaimInput,
): Promise<CreatedClaim | null> {
  const db = await useDatabase();
  await preparePartitionWrite(db, input.userId, input.partitionKey);

  const [original] = await db
    .select()
    .from(claims)
    .where(
      and(
        eq(claims.id, input.claimId),
        eq(claims.userId, input.userId),
        input.partitionKey === undefined
          ? isNull(claims.partitionKey)
          : eq(claims.partitionKey, input.partitionKey),
      ),
    )
    .limit(1);

  if (!original) return null;

  // Only active claims may be reattributed. Reattributing a non-active claim
  // would re-retract dead history and mint a new active claim, resurrecting an
  // assertion the lifecycle already settled.
  if (original.status !== "active") {
    throw new InactiveClaimReattributionError(original.id, original.status);
  }

  if (input.replace === "object" && original.objectNodeId === null) {
    throw new AttributeClaimObjectReattributionError(
      original.id,
      original.predicate,
    );
  }

  // Reattribution must never copy a malformed cross-partition claim into a
  // new partition. Validate every existing endpoint and its provenance source
  // against the concrete partition resolved by the route.
  await fetchOwnedNodes(
    db,
    input.userId,
    [
      original.subjectNodeId,
      ...(original.objectNodeId !== null ? [original.objectNodeId] : []),
      ...(original.assertedByNodeId !== null
        ? [original.assertedByNodeId]
        : []),
    ],
    input.partitionKey,
  );
  await assertSourcePartition({
    db,
    userId: input.userId,
    sourceId: original.sourceId,
    partitionKey: input.partitionKey,
  });

  // Validate the new endpoint node exists and is owned by the user. Reuse the
  // same ownership check createClaim uses so the error surface is identical.
  await fetchOwnedNodes(
    db,
    input.userId,
    [input.newNodeId],
    input.partitionKey,
  );

  // Compute the resulting endpoint pair and refuse a cross-scope inconsistency,
  // mirroring the guard merge enforces. For an attribute claim the object is a
  // scalar value (no node), so only the subject participates.
  const nextSubjectNodeId =
    input.replace === "subject" ? input.newNodeId : original.subjectNodeId;
  const nextObjectNodeId =
    input.replace === "object" ? input.newNodeId : original.objectNodeId;
  const scopeNodeIds: TypeId<"node">[] = [
    nextSubjectNodeId,
    ...(nextObjectNodeId !== null ? [nextObjectNodeId] : []),
  ];
  const scopeMap = await getEffectiveNodeScopes(db, input.userId, scopeNodeIds);
  const scopes = scopeNodeIds.map((id) => scopeMap.get(id) ?? "personal");
  const distinctScopes = new Set(scopes);
  if (distinctScopes.size > 1) {
    throw new CrossScopeMergeError(scopeNodeIds, [...distinctScopes]);
  }

  // Atomic retract-then-recreate: both the retraction and the new endpoint
  // claim land in one transaction so the graph never observes a dangling or
  // duplicated assertion.
  const inserted = await withSourceWriteFence(
    db,
    {
      userId: input.userId,
      partitionKey: input.partitionKey,
      sources: [{ sourceId: original.sourceId }],
    },
    async (tx) => {
      // The status check above is only an early rejection. Lock and re-check
      // the original inside the write transaction so a concurrent retract
      // cannot be followed by a replacement that resurrects dead history.
      const [lockedOriginal] = await tx
        .select()
        .from(claims)
        .where(
          and(
            eq(claims.id, original.id),
            eq(claims.userId, input.userId),
            input.partitionKey === undefined
              ? isNull(claims.partitionKey)
              : eq(claims.partitionKey, input.partitionKey),
          ),
        )
        .for("update")
        .limit(1);
      if (!lockedOriginal) {
        throw new InactiveClaimReattributionError(original.id, "retracted");
      }
      if (lockedOriginal.status !== "active") {
        throw new InactiveClaimReattributionError(
          lockedOriginal.id,
          lockedOriginal.status,
        );
      }

      const lockedNextSubjectNodeId =
        input.replace === "subject"
          ? input.newNodeId
          : lockedOriginal.subjectNodeId;
      const lockedNextObjectNodeId =
        input.replace === "object"
          ? input.newNodeId
          : lockedOriginal.objectNodeId;
      await tx
        .update(claims)
        .set({ status: "retracted", updatedAt: new Date() })
        .where(
          and(
            eq(claims.id, lockedOriginal.id),
            eq(claims.userId, input.userId),
          ),
        );

      const [created] = await tx
        .insert(claims)
        .values({
          userId: lockedOriginal.userId,
          partitionKey: lockedOriginal.partitionKey,
          subjectNodeId: lockedNextSubjectNodeId,
          objectNodeId: lockedNextObjectNodeId,
          objectValue: lockedOriginal.objectValue,
          predicate: lockedOriginal.predicate,
          statement: lockedOriginal.statement,
          description: lockedOriginal.description,
          metadata: lockedOriginal.metadata,
          objectInstant: lockedOriginal.objectInstant,
          sourceId: lockedOriginal.sourceId,
          scope: lockedOriginal.scope,
          assertedByKind: "user_confirmed",
          // When the subject is replaced, anchor provenance to the new subject —
          // mirrors how merge rewires subject-side attribution. When the object
          // is replaced the subject (and thus its provenance anchor) is unchanged.
          assertedByNodeId:
            input.replace === "subject"
              ? lockedNextSubjectNodeId
              : lockedOriginal.assertedByNodeId,
          statedAt: lockedOriginal.statedAt,
          validFrom: lockedOriginal.validFrom,
          validTo: lockedOriginal.validTo,
          status: "active",
        })
        .returning();

      if (!created) throw new Error("Failed to create reattributed claim");
      return created;
    },
  );

  logEvent("claim.retracted", {
    claimId: original.id,
    userId: original.userId,
    reason: "reattribute",
  });
  logEvent("claim.inserted", {
    claimId: inserted.id,
    userId: inserted.userId,
    predicate: inserted.predicate,
    kind: inserted.assertedByKind,
    scope: inserted.scope,
    subjectNodeId: inserted.subjectNodeId,
  });

  // Run the lifecycle pass over both touched claims so single-current
  // predicates settle correctly, then queue the embedding for the new claim.
  const lifecycleStartedAt = new Date();
  await applyClaimLifecycle(db, [inserted]);
  const { maybeEnqueueAtlasInvalidation } = await import(
    "./jobs/atlas-invalidation"
  );
  await maybeEnqueueAtlasInvalidation(db, input.userId, lifecycleStartedAt);
  const [finalized] = await fetchClaimsByIds(db, [inserted.id]);
  if (!finalized) throw new Error("Failed to fetch reattributed claim");

  await enqueueClaimEmbedding(finalized);

  const nodeMap = await fetchOwnedNodes(
    db,
    input.userId,
    [
      finalized.subjectNodeId,
      ...(finalized.objectNodeId !== null ? [finalized.objectNodeId] : []),
    ],
    input.partitionKey,
  );

  return {
    ...finalized,
    subjectLabel: nodeMap.get(finalized.subjectNodeId)?.label ?? null,
    objectLabel:
      finalized.objectNodeId !== null
        ? (nodeMap.get(finalized.objectNodeId)?.label ?? null)
        : null,
  };
}

/** Retract an active claim. User-facing updates only move claims out of active use. */
export async function updateClaim(
  userId: string,
  claimId: TypeId<"claim">,
  updates: { status: Extract<ClaimStatus, "retracted"> },
  partitionKey?: ContextPartitionKey,
): Promise<ClaimSelect | null> {
  const db = await useDatabase();
  await preparePartitionWrite(db, userId, partitionKey);
  const [updated] = await db
    .update(claims)
    .set({ status: updates.status, updatedAt: new Date() })
    .where(
      and(
        eq(claims.id, claimId),
        eq(claims.userId, userId),
        partitionKey === undefined
          ? isNull(claims.partitionKey)
          : eq(claims.partitionKey, partitionKey),
      ),
    )
    .returning();

  if (updated) {
    logEvent("claim.retracted", {
      claimId: updated.id,
      userId: updated.userId,
      reason: "user_update",
    });
  }

  return updated ?? null;
}
