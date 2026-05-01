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
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import {
  aliases,
  claims,
  nodeMetadata,
  nodes,
  sourceLinks,
  sources,
} from "~/db/schema";
import { createAlias, deleteAliasByText } from "~/lib/alias";
import { createClaim, type ClaimSelect } from "~/lib/claim";
import { applyClaimLifecycle } from "~/lib/claims/lifecycle";
import type { GraphNode } from "~/lib/jobs/cleanup-graph";
import { normalizeLabel } from "~/lib/label";
import { logEvent } from "~/lib/observability/log";
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

const RETRACTABLE_KINDS = new Set<ClaimSelect["assertedByKind"]>([
  "assistant_inferred",
]);

const CONTRADICTION_CITATION_KINDS = new Set<ClaimSelect["assertedByKind"]>([
  "user",
  "user_confirmed",
  "participant",
  "document_author",
]);

/** Thrown by `promote_assertion` when the source claim is not eligible. */
export class PromoteAssertionError extends Error {
  readonly claimId: TypeId<"claim">;
  constructor(claimId: TypeId<"claim">, message: string) {
    super(message);
    this.name = "PromoteAssertionError";
    this.claimId = claimId;
  }
}

/** Thrown when cleanup tries to retract a claim whose provenance is protected. */
export class RetractionNotAllowedError extends Error {
  readonly claimId: TypeId<"claim">;
  readonly assertedByKind: ClaimSelect["assertedByKind"];
  constructor(claim: ClaimSelect) {
    super(
      `retract_claim refused for ${claim.assertedByKind} claim ${claim.id}; use contradict_claim with a cited claim instead`,
    );
    this.name = "RetractionNotAllowedError";
    this.claimId = claim.id;
    this.assertedByKind = claim.assertedByKind;
  }
}

/** Thrown when cleanup tries to contradict a claim without a valid citation. */
export class ContradictionNotAllowedError extends Error {
  readonly claimId: TypeId<"claim">;
  readonly contradictedByClaimId: TypeId<"claim">;
  constructor(
    claimId: TypeId<"claim">,
    contradictedByClaimId: TypeId<"claim">,
    message: string,
  ) {
    super(message);
    this.name = "ContradictionNotAllowedError";
    this.claimId = claimId;
    this.contradictedByClaimId = contradictedByClaimId;
  }
}

/** Thrown when cleanup tries to hard-delete a node that still has evidence. */
export class DeleteNodeNotAllowedError extends Error {
  readonly nodeId: TypeId<"node">;
  constructor(
    nodeId: TypeId<"node">,
    counts: { claims: number; sourceLinks: number; aliases: number },
  ) {
    super(
      `delete_node refused for ${nodeId}; node still has claims=${counts.claims}, sourceLinks=${counts.sourceLinks}, aliases=${counts.aliases}`,
    );
    this.name = "DeleteNodeNotAllowedError";
    this.nodeId = nodeId;
  }
}

// =============================================================================
// Per-op helpers
// =============================================================================

/**
 * Retract an assistant-inferred claim: set status to `retracted` and re-run
 * lifecycle so any supersession chain that depended on this claim recomputes.
 *
 * Guardrail: cleanup may not retract claims attributed to users, documents,
 * participants, or system sources. "Not present in the bootstrap bundle" is
 * not evidence that a sourced claim is false. Non-inferred claims must use
 * `contradict_claim` with an explicit cited claim instead.
 */
export async function retractClaim(
  database: DbOrTx,
  userId: string,
  op: RetractClaimOp,
): Promise<ClaimSelect | null> {
  const [claim] = await database
    .select()
    .from(claims)
    .where(and(eq(claims.id, op.claimId), eq(claims.userId, userId)))
    .limit(1);

  if (!claim) return null;
  if (!RETRACTABLE_KINDS.has(claim.assertedByKind)) {
    throw new RetractionNotAllowedError(claim);
  }

  const [updated] = await database
    .update(claims)
    .set({ status: "retracted", updatedAt: new Date() })
    .where(
      and(
        eq(claims.id, op.claimId),
        eq(claims.userId, userId),
        eq(claims.assertedByKind, "assistant_inferred"),
      ),
    )
    .returning();

  if (!updated) return null;

  logEvent("claim.retracted", {
    claimId: updated.id,
    userId: updated.userId,
    reason: op.reason,
  });

  await applyClaimLifecycle(database, [updated]);
  return updated;
}

/**
 * Mark a claim as contradicted by another sourced claim.
 *
 * Policy:
 * - the citation must be a different claim
 * - the citation must be active
 * - the citation must be source-backed provenance, not assistant/system output
 * - the citation and target must live in the same scope
 */
export async function contradictClaim(
  database: DbOrTx,
  userId: string,
  op: ContradictClaimOp,
): Promise<ClaimSelect | null> {
  if (op.claimId === op.contradictedByClaimId) {
    throw new ContradictionNotAllowedError(
      op.claimId,
      op.contradictedByClaimId,
      "contradict_claim cannot cite the same claim it contradicts",
    );
  }

  const [target] = await database
    .select()
    .from(claims)
    .where(and(eq(claims.id, op.claimId), eq(claims.userId, userId)))
    .limit(1);
  if (!target) return null;

  const [citing] = await database
    .select()
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
  if (citing.status !== "active") {
    throw new ContradictionNotAllowedError(
      op.claimId,
      op.contradictedByClaimId,
      `contradict_claim citation ${op.contradictedByClaimId} is ${citing.status}, expected active`,
    );
  }
  if (!CONTRADICTION_CITATION_KINDS.has(citing.assertedByKind)) {
    throw new ContradictionNotAllowedError(
      op.claimId,
      op.contradictedByClaimId,
      `contradict_claim citation ${op.contradictedByClaimId} is ${citing.assertedByKind}, expected source-backed provenance`,
    );
  }
  if (target.scope !== citing.scope) {
    throw new ContradictionNotAllowedError(
      op.claimId,
      op.contradictedByClaimId,
      `contradict_claim scope mismatch: target is ${target.scope}, citation is ${citing.scope}`,
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

  logEvent("claim.contradicted", {
    claimId: updated.id,
    userId: updated.userId,
    contradictedByClaimId: op.contradictedByClaimId,
    reason: op.reason,
  });

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

  await assertNodeCanBeHardDeleted(database, userId, nodeId);

  const deleted = await database
    .delete(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .returning({ id: nodes.id });
  return deleted.length > 0;
}

async function assertNodeCanBeHardDeleted(
  database: DbOrTx,
  userId: string,
  nodeId: TypeId<"node">,
): Promise<void> {
  const [claimRow, sourceLinkRow, aliasRow] = await Promise.all([
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(claims)
      .where(
        and(
          eq(claims.userId, userId),
          or(
            eq(claims.subjectNodeId, nodeId),
            eq(claims.objectNodeId, nodeId),
            eq(claims.assertedByNodeId, nodeId),
          ),
        ),
      ),
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(sourceLinks)
      .where(eq(sourceLinks.nodeId, nodeId)),
    database
      .select({ count: sql<number>`count(*)::int` })
      .from(aliases)
      .where(
        and(eq(aliases.userId, userId), eq(aliases.canonicalNodeId, nodeId)),
      ),
  ]);

  const counts = {
    claims: claimRow[0]?.count ?? 0,
    sourceLinks: sourceLinkRow[0]?.count ?? 0,
    aliases: aliasRow[0]?.count ?? 0,
  };
  if (counts.claims > 0 || counts.sourceLinks > 0 || counts.aliases > 0) {
    throw new DeleteNodeNotAllowedError(nodeId, counts);
  }
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
 * Supersession contract (do not break this without re-checking call sites):
 * the new `user_confirmed` claim must outrank the original `assistant_inferred`
 * row in `compareLifecycleOrder`. Today this holds two ways: (a) the new claim
 * has a strictly-later `statedAt` (we pass `new Date()` explicitly below — even
 * when the original's `statedAt` is "now", the new row's wall-clock value is
 * always >=), and (b) the trust-rank tiebreaker puts `user_confirmed` after
 * `assistant_inferred` when `statedAt` ties at the second. Future maintainers
 * editing `compareLifecycleOrder` MUST keep `user_confirmed` outranking
 * `assistant_inferred` on tie, otherwise promotion silently no-ops on
 * batch-ingested same-second claims.
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
  // `statedAt` is passed explicitly (rather than relying on createClaim's
  // default) to make the supersession contract above legible at the call site.
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
    statedAt: new Date(),
  });
}

// =============================================================================
// Dispatcher
// =============================================================================

export interface ApplyCleanupOperationsResult {
  applied: number;
  skipped: number;
  errors: Array<{ kind: CleanupOperation["kind"]; message: string }>;
  /**
   * Real node ids touched by node-shaped operations: merge survivors,
   * newly-created nodes, and subjects of `add_claim`. Used by the
   * iterative cleanup loop to harvest follow-up seeds.
   */
  affectedNodeIds: TypeId<"node">[];
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
 *
 * `allowedClaimIds` (optional) bounds claim-targeting operations
 * (`retract_claim`, `contradict_claim`, `promote_assertion`) to the set of
 * real claim ids that were rendered into the prompt. Any op referencing a
 * claim id outside the set is rejected (recorded in `errors`, no DB write).
 * For `contradict_claim` the citation (`contradictedByClaimId`) is checked
 * too — the model must cite a claim the user has shown it. When the parameter
 * is omitted (e.g. unit-test callers exercising helpers directly), no bound
 * is enforced, preserving the previous behavior.
 */
export async function applyCleanupOperations(
  databaseOverride: DbOrTx | undefined,
  userId: string,
  operations: CleanupOperation[],
  idMapper: TemporaryIdMapper<GraphNode, string>,
  allowedClaimIds?: ReadonlySet<TypeId<"claim">>,
): Promise<ApplyCleanupOperationsResult> {
  const database = databaseOverride ?? (await useDatabase());

  // tempId → real node id map. Seeded from the mapper, augmented as ops run.
  const tempIdToNodeId = new Map<string, TypeId<"node">>();
  for (const { item, id } of idMapper.entries()) {
    tempIdToNodeId.set(id, item.id);
  }
  const resolveTempId: TempIdResolver = (tempId) => tempIdToNodeId.get(tempId);

  const affectedNodeIds = new Set<TypeId<"node">>();
  const result: ApplyCleanupOperationsResult = {
    applied: 0,
    skipped: 0,
    errors: [],
    affectedNodeIds: [],
  };

  for (const op of operations) {
    const guardError = checkAllowedClaimIds(op, allowedClaimIds);
    if (guardError) {
      console.warn(
        `[cleanup-ops] out_of_subgraph_claim_ref user=${userId} kind=${op.kind} ${guardError}`,
      );
      result.errors.push({ kind: op.kind, message: guardError });
      continue;
    }
    try {
      const ok = await runOne(
        database,
        userId,
        op,
        resolveTempId,
        (tempId, realId) => {
          tempIdToNodeId.set(tempId, realId);
        },
        (nodeId) => affectedNodeIds.add(nodeId),
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

  result.affectedNodeIds = Array.from(affectedNodeIds);
  return result;
}

/**
 * Reject claim-targeting ops whose claim ids fall outside the rendered
 * subgraph. Returns an error message string when the op should be rejected,
 * `null` otherwise. Returns `null` when the bound is undefined (legacy
 * callers / unit tests that don't pass a subgraph).
 */
function checkAllowedClaimIds(
  op: CleanupOperation,
  allowedClaimIds: ReadonlySet<TypeId<"claim">> | undefined,
): string | null {
  if (allowedClaimIds === undefined) return null;
  switch (op.kind) {
    case "retract_claim":
      if (!allowedClaimIds.has(op.claimId)) {
        return `retract_claim references claim ${op.claimId} outside the rendered subgraph`;
      }
      return null;
    case "contradict_claim":
      if (!allowedClaimIds.has(op.claimId)) {
        return `contradict_claim references claim ${op.claimId} outside the rendered subgraph`;
      }
      if (!allowedClaimIds.has(op.contradictedByClaimId)) {
        return `contradict_claim cites claim ${op.contradictedByClaimId} outside the rendered subgraph`;
      }
      return null;
    case "promote_assertion":
      if (!allowedClaimIds.has(op.claimId)) {
        return `promote_assertion references claim ${op.claimId} outside the rendered subgraph`;
      }
      return null;
    default:
      return null;
  }
}

async function runOne(
  database: DbOrTx,
  userId: string,
  op: CleanupOperation,
  resolveTempId: TempIdResolver,
  registerTempId: (tempId: string, realId: TypeId<"node">) => void,
  trackAffected: (nodeId: TypeId<"node">) => void,
): Promise<boolean> {
  switch (op.kind) {
    case "merge_nodes": {
      const merged = await mergeNodesOp(userId, op, resolveTempId);
      if (!merged) return false;
      // After merge, removed temp ids should resolve to the survivor.
      for (const removeTempId of op.removeTempIds) {
        registerTempId(removeTempId, merged.survivorId);
      }
      trackAffected(merged.survivorId);
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
      if (created === null) return false;
      trackAffected(created.subjectNodeId);
      if (created.objectNodeId) trackAffected(created.objectNodeId);
      return true;
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
      trackAffected(newId);
      return true;
    }
  }
}
