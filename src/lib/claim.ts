/** Claim operations: create, retract, delete, reattribute. */
import { and, eq, inArray } from "drizzle-orm";
import { claims, claimEmbeddings, nodeMetadata, nodes } from "~/db/schema";
import { applyClaimLifecycle, fetchClaimsByIds } from "~/lib/claims/lifecycle";
import { generateEmbeddings } from "~/lib/embeddings";
import { CrossScopeMergeError } from "~/lib/node";
import { getEffectiveNodeScopes } from "~/lib/node-scope";
import { logEvent } from "~/lib/observability/log";
import { ensureSystemSource } from "~/lib/sources";
import {
  TaskStatusEnum,
  type AssertedByKind,
  type ClaimStatus,
  type Predicate,
  type ReattributeReplace,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

type Database = Awaited<ReturnType<typeof useDatabase>>;

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

async function fetchOwnedNodeLabels(
  db: Database,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<Map<TypeId<"node">, string | null>> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) return new Map();

  const found = await db
    .select({ id: nodes.id, label: nodeMetadata.label })
    .from(nodes)
    .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, uniqueNodeIds)));

  if (found.length !== uniqueNodeIds.length) {
    const foundIds = new Set(found.map((node) => node.id));
    const missing = uniqueNodeIds.filter((id) => !foundIds.has(id));
    throw new NodesNotFoundError(userId, missing);
  }

  return new Map(found.map((node) => [node.id, node.label ?? null]));
}

async function insertClaimEmbedding(
  db: Database,
  claim: Pick<
    ClaimSelect,
    "id" | "predicate" | "statement" | "status" | "statedAt"
  >,
): Promise<void> {
  if (shouldSkipEmbeddingPersistence()) return;

  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [claimEmbeddingText(claim)],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (!embedding) return;

  await db.insert(claimEmbeddings).values({
    claimId: claim.id,
    embedding,
    modelName: "jina-embeddings-v3",
  });
}

/** Create a sourced claim. Uses the per-user manual source when sourceId is omitted. */
export async function createClaim(
  input: CreateClaimInput,
): Promise<CreatedClaim> {
  const db = await useDatabase();
  const hasObjectNode = input.objectNodeId !== undefined;
  const hasObjectValue = input.objectValue !== undefined;
  if (hasObjectNode === hasObjectValue) {
    throw new Error("Exactly one of objectNodeId or objectValue is required");
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

  const nodeLabels = await fetchOwnedNodeLabels(db, input.userId, [
    input.subjectNodeId,
    ...(input.objectNodeId !== undefined ? [input.objectNodeId] : []),
  ]);

  const sourceId =
    input.sourceId ?? (await ensureSystemSource(db, input.userId, "manual"));

  const [inserted] = await db
    .insert(claims)
    .values({
      userId: input.userId,
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
    .returning();

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
  await maybeEnqueueAtlasInvalidation(db, input.userId, lifecycleStartedAt);
  const [finalized] = await fetchClaimsByIds(db, [inserted.id]);
  if (!finalized) throw new Error("Failed to fetch created claim");

  await insertClaimEmbedding(db, finalized);
  return {
    ...finalized,
    subjectLabel: nodeLabels.get(input.subjectNodeId) ?? null,
    objectLabel:
      input.objectNodeId !== undefined
        ? (nodeLabels.get(input.objectNodeId) ?? null)
        : null,
  };
}

/** Hard-delete a claim by ID. */
export async function deleteClaim(
  userId: string,
  claimId: TypeId<"claim">,
): Promise<boolean> {
  const db = await useDatabase();
  const [deletedClaim] = await db
    .delete(claims)
    .where(and(eq(claims.id, claimId), eq(claims.userId, userId)))
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

export type ReattributeClaimInput = {
  userId: string;
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
 * Returns the newly created claim in the same shape as {@link createClaim};
 * resolves `null` when the original claim does not exist for the user.
 */
export async function reattributeClaim(
  input: ReattributeClaimInput,
): Promise<CreatedClaim | null> {
  const db = await useDatabase();

  const [original] = await db
    .select()
    .from(claims)
    .where(and(eq(claims.id, input.claimId), eq(claims.userId, input.userId)))
    .limit(1);

  if (!original) return null;

  if (input.replace === "object" && original.objectNodeId === null) {
    throw new AttributeClaimObjectReattributionError(
      original.id,
      original.predicate,
    );
  }

  // Validate the new endpoint node exists and is owned by the user. Reuse the
  // same ownership check createClaim uses so the error surface is identical.
  await fetchOwnedNodeLabels(db, input.userId, [input.newNodeId]);

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
  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(claims)
      .set({ status: "retracted", updatedAt: new Date() })
      .where(and(eq(claims.id, original.id), eq(claims.userId, input.userId)));

    const [created] = await tx
      .insert(claims)
      .values({
        userId: original.userId,
        subjectNodeId: nextSubjectNodeId,
        objectNodeId: nextObjectNodeId,
        objectValue: original.objectValue,
        predicate: original.predicate,
        statement: original.statement,
        description: original.description,
        metadata: original.metadata,
        objectInstant: original.objectInstant,
        sourceId: original.sourceId,
        scope: original.scope,
        assertedByKind: "user_confirmed",
        // When the subject is replaced, anchor provenance to the new subject —
        // mirrors how merge rewires subject-side attribution. When the object
        // is replaced the subject (and thus its provenance anchor) is unchanged.
        assertedByNodeId:
          input.replace === "subject"
            ? nextSubjectNodeId
            : original.assertedByNodeId,
        statedAt: original.statedAt,
        validFrom: original.validFrom,
        validTo: original.validTo,
        status: "active",
      })
      .returning();

    if (!created) throw new Error("Failed to create reattributed claim");
    return created;
  });

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
  // predicates settle correctly, then refresh the embedding for the new claim.
  const lifecycleStartedAt = new Date();
  await applyClaimLifecycle(db, [inserted]);
  const { maybeEnqueueAtlasInvalidation } = await import(
    "./jobs/atlas-invalidation"
  );
  await maybeEnqueueAtlasInvalidation(db, input.userId, lifecycleStartedAt);
  const [finalized] = await fetchClaimsByIds(db, [inserted.id]);
  if (!finalized) throw new Error("Failed to fetch reattributed claim");

  await insertClaimEmbedding(db, finalized);

  const labelMap = await fetchOwnedNodeLabels(db, input.userId, [
    finalized.subjectNodeId,
    ...(finalized.objectNodeId !== null ? [finalized.objectNodeId] : []),
  ]);

  return {
    ...finalized,
    subjectLabel: labelMap.get(finalized.subjectNodeId) ?? null,
    objectLabel:
      finalized.objectNodeId !== null
        ? (labelMap.get(finalized.objectNodeId) ?? null)
        : null,
  };
}

/** Retract an active claim. User-facing updates only move claims out of active use. */
export async function updateClaim(
  userId: string,
  claimId: TypeId<"claim">,
  updates: { status: Extract<ClaimStatus, "retracted"> },
): Promise<ClaimSelect | null> {
  const db = await useDatabase();
  const [updated] = await db
    .update(claims)
    .set({ status: updates.status, updatedAt: new Date() })
    .where(and(eq(claims.id, claimId), eq(claims.userId, userId)))
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
