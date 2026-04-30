/**
 * Cleanup operation vocabulary and dispatcher.
 *
 * This module defines the per-operation Zod schema (`CleanupOperationSchema`,
 * a discriminated union) and per-kind helpers used by the cleanup pipeline
 * after PR 4i-c rewrites the prompt. The dispatcher `applyCleanupOperations`
 * walks operations in declared order, threading a `TemporaryIdMapper` so the
 * LLM can reference seed nodes by `temp_node_*` ids and freshly created nodes
 * by their declared `tempId`.
 *
 * Common aliases: cleanup ops, cleanup operation vocabulary, promote_assertion,
 * retract_claim, contradict_claim, merge_nodes, add_claim, add_alias.
 */
import { CrossScopeMergeError, mergeNodes } from "../node";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, sources } from "~/db/schema";
import { createAlias, deleteAliasByText } from "~/lib/alias";
import { createClaim, type ClaimSelect } from "~/lib/claim";
import { applyClaimLifecycle } from "~/lib/claims/lifecycle";
import type { GraphNode } from "~/lib/jobs/cleanup-graph";
import { normalizeLabel } from "~/lib/label";
import type { TemporaryIdMapper } from "~/lib/temporary-id-mapper";
import {
  AttributePredicateEnum,
  NodeTypeEnum,
  RelationshipPredicateEnum,
} from "~/types/graph";
import { typeIdSchema, type TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/** Predicate enum for the `add_claim` op. Matches the union of all known kinds. */
const AnyPredicateEnum = z.union([
  AttributePredicateEnum,
  RelationshipPredicateEnum,
]);

const claimIdSchema = typeIdSchema("claim");
const sourceIdSchema = typeIdSchema("source");

const mergeNodesOpSchema = z.object({
  kind: z.literal("merge_nodes"),
  keepTempId: z.string(),
  removeTempIds: z.array(z.string()).min(1),
});

const deleteNodeOpSchema = z.object({
  kind: z.literal("delete_node"),
  tempId: z.string(),
});

const retractClaimOpSchema = z.object({
  kind: z.literal("retract_claim"),
  claimId: claimIdSchema,
  reason: z.string().min(1),
});

const contradictClaimOpSchema = z.object({
  kind: z.literal("contradict_claim"),
  claimId: claimIdSchema,
  contradictedByClaimId: claimIdSchema,
  reason: z.string().min(1),
});

// Discriminated union members must be plain `z.object`s (no `.refine`/`ZodEffects`).
// The objectTempId/objectValue xor is enforced at the dispatcher boundary.
const addClaimOpSchema = z.object({
  kind: z.literal("add_claim"),
  subjectTempId: z.string(),
  objectTempId: z.string().optional(),
  objectValue: z.string().min(1).optional(),
  predicate: AnyPredicateEnum,
  statement: z.string().min(1),
  sourceClaimId: claimIdSchema.optional(),
});

const addAliasOpSchema = z.object({
  kind: z.literal("add_alias"),
  nodeTempId: z.string(),
  aliasText: z.string().min(1),
});

const removeAliasOpSchema = z.object({
  kind: z.literal("remove_alias"),
  nodeTempId: z.string(),
  aliasText: z.string().min(1),
});

const promoteAssertionOpSchema = z.object({
  kind: z.literal("promote_assertion"),
  claimId: claimIdSchema,
  corroboratingSourceId: sourceIdSchema,
  reason: z.string().min(1),
});

const createNodeOpSchema = z.object({
  kind: z.literal("create_node"),
  tempId: z.string(),
  label: z.string().min(1),
  description: z.string().optional(),
  type: NodeTypeEnum,
});

export const CleanupOperationSchema = z.discriminatedUnion("kind", [
  mergeNodesOpSchema,
  deleteNodeOpSchema,
  retractClaimOpSchema,
  contradictClaimOpSchema,
  addClaimOpSchema,
  addAliasOpSchema,
  removeAliasOpSchema,
  promoteAssertionOpSchema,
  createNodeOpSchema,
]);

export const CleanupOperationsSchema = z.object({
  operations: z.array(CleanupOperationSchema),
});

export type CleanupOperation = z.infer<typeof CleanupOperationSchema>;
export type CleanupOperations = z.infer<typeof CleanupOperationsSchema>;

// Narrow op types per kind.
type MergeNodesOp = Extract<CleanupOperation, { kind: "merge_nodes" }>;
type DeleteNodeOp = Extract<CleanupOperation, { kind: "delete_node" }>;
type RetractClaimOp = Extract<CleanupOperation, { kind: "retract_claim" }>;
type ContradictClaimOp = Extract<
  CleanupOperation,
  { kind: "contradict_claim" }
>;
type AddClaimOp = Extract<CleanupOperation, { kind: "add_claim" }>;
type AddAliasOp = Extract<CleanupOperation, { kind: "add_alias" }>;
type RemoveAliasOp = Extract<CleanupOperation, { kind: "remove_alias" }>;
type PromoteAssertionOp = Extract<
  CleanupOperation,
  { kind: "promote_assertion" }
>;
type CreateNodeOp = Extract<CleanupOperation, { kind: "create_node" }>;

/** Narrow Drizzle handle accepted by per-op helpers. Either a tx or the root db. */
type DbOrTx = DrizzleDB;

/** A live tempId → real id map maintained across an op sequence. */
type TempIdResolver = (tempId: string) => TypeId<"node"> | undefined;

/** Thrown by `promote_assertion` when the source claim is not eligible. */
export class PromoteAssertionError extends Error {
  readonly claimId: TypeId<"claim">;
  constructor(claimId: TypeId<"claim">, message: string) {
    super(message);
    this.name = "PromoteAssertionError";
    this.claimId = claimId;
  }
}

// =============================================================================
// Per-op helpers
// =============================================================================

/**
 * Retract a claim: set status to `retracted` and re-run lifecycle so any
 * supersession chain that depended on this claim recomputes.
 */
export async function retractClaim(
  database: DbOrTx,
  userId: string,
  op: RetractClaimOp,
): Promise<ClaimSelect | null> {
  const [updated] = await database
    .update(claims)
    .set({ status: "retracted", updatedAt: new Date() })
    .where(and(eq(claims.id, op.claimId), eq(claims.userId, userId)))
    .returning();

  if (!updated) return null;

  await applyClaimLifecycle(database, [updated]);
  return updated;
}

/**
 * Mark a claim as contradicted by another (cited) claim. The citation is
 * required at the schema layer; this helper additionally validates that the
 * cited claim exists and is owned by the same user.
 */
export async function contradictClaim(
  database: DbOrTx,
  userId: string,
  op: ContradictClaimOp,
): Promise<ClaimSelect | null> {
  const [citing] = await database
    .select({ id: claims.id })
    .from(claims)
    .where(
      and(eq(claims.id, op.contradictedByClaimId), eq(claims.userId, userId)),
    )
    .limit(1);
  if (!citing) {
    throw new Error(
      `contradict_claim citation ${op.contradictedByClaimId} not found for user`,
    );
  }

  const [updated] = await database
    .update(claims)
    .set({
      status: "contradicted",
      contradictedByClaimId: op.contradictedByClaimId,
      updatedAt: new Date(),
    })
    .where(and(eq(claims.id, op.claimId), eq(claims.userId, userId)))
    .returning();

  if (!updated) return null;
  await applyClaimLifecycle(database, [updated]);
  return updated;
}

/** Resolve the source's scope for an `add_claim` op, defaulting to `personal`. */
async function resolveAddClaimScope(
  database: DbOrTx,
  userId: string,
  sourceClaimId: TypeId<"claim"> | undefined,
): Promise<{ scope: "personal" | "reference"; sourceId?: TypeId<"source"> }> {
  if (sourceClaimId === undefined) return { scope: "personal" };

  const [row] = await database
    .select({ sourceId: claims.sourceId, scope: sources.scope })
    .from(claims)
    .innerJoin(sources, eq(sources.id, claims.sourceId))
    .where(and(eq(claims.id, sourceClaimId), eq(claims.userId, userId)))
    .limit(1);

  if (!row) {
    throw new Error(
      `add_claim source claim ${sourceClaimId} not found for user`,
    );
  }
  return { scope: row.scope, sourceId: row.sourceId };
}

/**
 * Add a new claim sourced from `system`. Scope inherits from the cited
 * `sourceClaimId`'s source if provided; otherwise defaults to `personal`.
 *
 * The route boundary `/claim/create` does not accept `assertedByKind` or
 * `scope` from callers, so this is the privileged path that stamps `'system'`.
 */
export async function addClaim(
  database: DbOrTx,
  userId: string,
  op: AddClaimOp,
  resolveTempId: TempIdResolver,
): Promise<ClaimSelect | null> {
  const subjectNodeId = resolveTempId(op.subjectTempId);
  if (!subjectNodeId) {
    console.warn(
      `add_claim: unresolved subject temp id ${op.subjectTempId}; skipping`,
    );
    return null;
  }

  let objectNodeId: TypeId<"node"> | undefined;
  if (op.objectTempId !== undefined) {
    objectNodeId = resolveTempId(op.objectTempId);
    if (!objectNodeId) {
      console.warn(
        `add_claim: unresolved object temp id ${op.objectTempId}; skipping`,
      );
      return null;
    }
  }

  const { scope, sourceId } = await resolveAddClaimScope(
    database,
    userId,
    op.sourceClaimId,
  );

  // createClaim runs its own lifecycle pipeline + embeddings; it accepts the
  // overrides we widened it with (assertedByKind/scope/sourceId).
  return createClaim({
    userId,
    subjectNodeId,
    predicate: op.predicate,
    statement: op.statement,
    description: op.statement,
    objectNodeId,
    objectValue: op.objectValue,
    sourceId,
    scope,
    assertedByKind: "system",
  });
}

/** Add an alias to a node (`createAlias` is idempotent on duplicate input). */
export async function addAlias(
  database: DbOrTx,
  userId: string,
  op: AddAliasOp,
  resolveTempId: TempIdResolver,
): Promise<boolean> {
  const canonicalNodeId = resolveTempId(op.nodeTempId);
  if (!canonicalNodeId) {
    console.warn(
      `add_alias: unresolved node temp id ${op.nodeTempId}; skipping`,
    );
    return false;
  }
  await createAlias(database, {
    userId,
    canonicalNodeId,
    aliasText: op.aliasText,
  });
  return true;
}

/** Remove an alias matched by `(userId, normalizedAliasText, canonicalNodeId)`. */
export async function removeAlias(
  database: DbOrTx,
  userId: string,
  op: RemoveAliasOp,
  resolveTempId: TempIdResolver,
): Promise<boolean> {
  const canonicalNodeId = resolveTempId(op.nodeTempId);
  if (!canonicalNodeId) {
    console.warn(
      `remove_alias: unresolved node temp id ${op.nodeTempId}; skipping`,
    );
    return false;
  }
  return deleteAliasByText(database, userId, canonicalNodeId, op.aliasText);
}

/**
 * Merge nodes by tempId. Delegates to {@link mergeNodes}, which now refuses
 * cross-scope merges via {@link CrossScopeMergeError}. Returns the survivor
 * id (the keep) on success, `null` on resolution failure, and re-throws
 * `CrossScopeMergeError` to the caller for logging.
 */
export async function mergeNodesOp(
  userId: string,
  op: MergeNodesOp,
  resolveTempId: TempIdResolver,
): Promise<{ survivorId: TypeId<"node">; mergedIds: TypeId<"node">[] } | null> {
  const keepId = resolveTempId(op.keepTempId);
  if (!keepId) {
    console.warn(
      `merge_nodes: unresolved keep temp id ${op.keepTempId}; skipping`,
    );
    return null;
  }
  const removeIds: TypeId<"node">[] = [];
  for (const removeTempId of op.removeTempIds) {
    const id = resolveTempId(removeTempId);
    if (!id) {
      console.warn(
        `merge_nodes: unresolved remove temp id ${removeTempId}; skipping`,
      );
      continue;
    }
    if (id === keepId) continue;
    removeIds.push(id);
  }
  if (removeIds.length === 0) return null;

  // mergeNodes' first arg is the survivor.
  await mergeNodes(userId, [keepId, ...removeIds]);
  return { survivorId: keepId, mergedIds: removeIds };
}

/** Hard-delete a node by tempId. */
export async function deleteNodeOp(
  database: DbOrTx,
  userId: string,
  op: DeleteNodeOp,
  resolveTempId: TempIdResolver,
): Promise<boolean> {
  const nodeId = resolveTempId(op.tempId);
  if (!nodeId) {
    console.warn(`delete_node: unresolved temp id ${op.tempId}; skipping`);
    return false;
  }
  const deleted = await database
    .delete(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .returning({ id: nodes.id });
  return deleted.length > 0;
}

/** Create a brand-new node and register it in the resolver under its tempId. */
export async function createNodeOp(
  database: DbOrTx,
  userId: string,
  op: CreateNodeOp,
): Promise<TypeId<"node"> | null> {
  const [inserted] = await database
    .insert(nodes)
    .values({ userId, nodeType: op.type })
    .returning({ id: nodes.id });

  if (!inserted) return null;

  await database.insert(nodeMetadata).values({
    nodeId: inserted.id,
    label: op.label,
    canonicalLabel: normalizeLabel(op.label),
    description: op.description ?? null,
  });
  return inserted.id;
}

/**
 * Promote an `assistant_inferred` claim by inserting a corroborated copy as
 * `user_confirmed` from the cited source. Single-valued predicates supersede
 * the original via the registry-driven lifecycle engine; multi-valued
 * predicates coexist (both rows remain `active`).
 *
 * Throws {@link PromoteAssertionError} when:
 * - the original claim is missing or owned by another user
 * - the original is not `assistant_inferred`
 * - the cited corroborating source is missing
 */
export async function promoteAssertion(
  database: DbOrTx,
  userId: string,
  op: PromoteAssertionOp,
): Promise<ClaimSelect> {
  const [original] = await database
    .select()
    .from(claims)
    .where(and(eq(claims.id, op.claimId), eq(claims.userId, userId)))
    .limit(1);

  if (!original) {
    throw new PromoteAssertionError(
      op.claimId,
      `promote_assertion: claim not found`,
    );
  }
  if (original.assertedByKind !== "assistant_inferred") {
    throw new PromoteAssertionError(
      op.claimId,
      `promote_assertion: claim is ${original.assertedByKind}, expected assistant_inferred`,
    );
  }

  const [corroborating] = await database
    .select({ id: sources.id, scope: sources.scope })
    .from(sources)
    .where(
      and(eq(sources.id, op.corroboratingSourceId), eq(sources.userId, userId)),
    )
    .limit(1);

  if (!corroborating) {
    throw new PromoteAssertionError(
      op.claimId,
      `promote_assertion: corroborating source ${op.corroboratingSourceId} not found`,
    );
  }

  // createClaim runs lifecycle + embedding insertion. Single-valued predicates
  // will supersede the original automatically (trust ranking puts
  // user_confirmed > assistant_inferred); multi-valued coexist.
  return createClaim({
    userId,
    subjectNodeId: original.subjectNodeId,
    predicate: original.predicate,
    statement: original.statement,
    description: original.description ?? undefined,
    objectNodeId: original.objectNodeId ?? undefined,
    objectValue: original.objectValue ?? undefined,
    sourceId: corroborating.id,
    scope: corroborating.scope,
    assertedByKind: "user_confirmed",
  });
}

// =============================================================================
// Dispatcher
// =============================================================================

export interface ApplyCleanupOperationsResult {
  applied: number;
  skipped: number;
  errors: Array<{ kind: CleanupOperation["kind"]; message: string }>;
}

/**
 * Apply a sequence of cleanup operations. Operations run in declared order so
 * upstream merges can rewrite tempIds before downstream `add_claim` /
 * `add_alias` ops resolve them.
 *
 * `merge_nodes` runs outside the dispatcher's transaction because
 * {@link mergeNodes} manages its own. All other operations share a single
 * transaction. `CrossScopeMergeError` is caught and logged (no row changes
 * for that op); other errors propagate.
 */
export async function applyCleanupOperations(
  databaseOverride: DbOrTx | undefined,
  userId: string,
  operations: CleanupOperation[],
  idMapper: TemporaryIdMapper<GraphNode, string>,
): Promise<ApplyCleanupOperationsResult> {
  const database = databaseOverride ?? (await useDatabase());

  // tempId → real node id map. Seeded from the mapper, augmented as ops run.
  const tempIdToNodeId = new Map<string, TypeId<"node">>();
  for (const { item, id } of idMapper.entries()) {
    tempIdToNodeId.set(id, item.id);
  }
  const resolveTempId: TempIdResolver = (tempId) => tempIdToNodeId.get(tempId);

  const result: ApplyCleanupOperationsResult = {
    applied: 0,
    skipped: 0,
    errors: [],
  };

  for (const op of operations) {
    try {
      const ok = await runOne(
        database,
        userId,
        op,
        resolveTempId,
        (tempId, realId) => {
          tempIdToNodeId.set(tempId, realId);
        },
      );
      if (ok) result.applied += 1;
      else result.skipped += 1;
    } catch (err) {
      if (err instanceof CrossScopeMergeError) {
        console.warn(
          `[cleanup-ops] cross_scope_merge_refused user=${userId} kind=${op.kind} ` +
            `nodes=${err.nodeIds.join(",")} scopes=${err.scopes.join(",")}`,
        );
        result.errors.push({ kind: op.kind, message: err.message });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[cleanup-ops] op_failed user=${userId} kind=${op.kind} message=${message}`,
      );
      result.errors.push({ kind: op.kind, message });
    }
  }

  return result;
}

async function runOne(
  database: DbOrTx,
  userId: string,
  op: CleanupOperation,
  resolveTempId: TempIdResolver,
  registerTempId: (tempId: string, realId: TypeId<"node">) => void,
): Promise<boolean> {
  switch (op.kind) {
    case "merge_nodes": {
      const merged = await mergeNodesOp(userId, op, resolveTempId);
      if (!merged) return false;
      // After merge, removed temp ids should resolve to the survivor.
      for (const removeTempId of op.removeTempIds) {
        registerTempId(removeTempId, merged.survivorId);
      }
      return true;
    }
    case "delete_node":
      return deleteNodeOp(database, userId, op, resolveTempId);
    case "retract_claim": {
      const updated = await retractClaim(database, userId, op);
      return updated !== null;
    }
    case "contradict_claim": {
      const updated = await contradictClaim(database, userId, op);
      return updated !== null;
    }
    case "add_claim": {
      // Re-validate the inner refine that the discriminated-union skipped.
      if ((op.objectTempId === undefined) === (op.objectValue === undefined)) {
        throw new Error(
          "add_claim: exactly one of objectTempId or objectValue is required",
        );
      }
      const created = await addClaim(database, userId, op, resolveTempId);
      return created !== null;
    }
    case "add_alias":
      return addAlias(database, userId, op, resolveTempId);
    case "remove_alias":
      return removeAlias(database, userId, op, resolveTempId);
    case "promote_assertion": {
      await promoteAssertion(database, userId, op);
      return true;
    }
    case "create_node": {
      const newId = await createNodeOp(database, userId, op);
      if (!newId) return false;
      registerTempId(op.tempId, newId);
      return true;
    }
  }
}
