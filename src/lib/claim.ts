/** Claim operations: create, retract, delete. */
import { and, eq, inArray } from "drizzle-orm";
import { claims, claimEmbeddings, nodeMetadata, nodes } from "~/db/schema";
import { applyClaimLifecycle, fetchClaimsByIds } from "~/lib/claims/lifecycle";
import { generateEmbeddings } from "~/lib/embeddings";
import { logEvent } from "~/lib/observability/log";
import { ensureSystemSource } from "~/lib/sources";
import {
  TaskStatusEnum,
  type AssertedByKind,
  type ClaimStatus,
  type Predicate,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

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
    throw new Error("One or more nodes not found");
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
