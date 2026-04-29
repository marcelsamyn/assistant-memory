/** Claim operations: create, retract, delete. */
import { and, eq, inArray } from "drizzle-orm";
import { claims, claimEmbeddings, nodes } from "~/db/schema";
import { applyClaimLifecycle, fetchClaimsByIds } from "~/lib/claims/lifecycle";
import { generateEmbeddings } from "~/lib/embeddings";
import { ensureSystemSource } from "~/lib/sources";
import type { ClaimStatus, Predicate } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

type Database = Awaited<ReturnType<typeof useDatabase>>;

export type ClaimSelect = typeof claims.$inferSelect;

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

async function validateNodeOwnership(
  db: Database,
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<void> {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) return;

  const found = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, uniqueNodeIds)));

  if (found.length !== uniqueNodeIds.length) {
    throw new Error("One or more nodes not found");
  }
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
): Promise<ClaimSelect> {
  const db = await useDatabase();
  const hasObjectNode = input.objectNodeId !== undefined;
  const hasObjectValue = input.objectValue !== undefined;
  if (hasObjectNode === hasObjectValue) {
    throw new Error("Exactly one of objectNodeId or objectValue is required");
  }

  await validateNodeOwnership(db, input.userId, [
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
      scope: "personal",
      assertedByKind: "user",
      statedAt: input.statedAt ?? new Date(),
      validFrom: input.validFrom,
      validTo: input.validTo,
      status: "active",
    })
    .returning();

  if (!inserted) throw new Error("Failed to create claim");

  const lifecycleStartedAt = new Date();
  await applyClaimLifecycle(db, [inserted]);
  const { maybeEnqueueAtlasInvalidation } = await import(
    "./jobs/atlas-invalidation"
  );
  await maybeEnqueueAtlasInvalidation(db, input.userId, lifecycleStartedAt);
  const [finalized] = await fetchClaimsByIds(db, [inserted.id]);
  if (!finalized) throw new Error("Failed to fetch created claim");

  await insertClaimEmbedding(db, finalized);
  return finalized;
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

  return updated ?? null;
}
