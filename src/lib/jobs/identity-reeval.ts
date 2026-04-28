/**
 * Background identity re-evaluation job.
 *
 * After ingestion has settled (claims persisted, embeddings written, lifecycle
 * applied), this job runs identity-resolution signals 3 (embedding similarity)
 * and 4 (claim profile compatibility) for a single affected node against
 * existing nodes of the same type AND same scope. A positive hit is recorded
 * as a structured "merge proposal" log entry — never auto-applied.
 *
 * The Phase 4 cleanup-graph rewrite is the consumer of these proposals: it
 * will read them out of structured logs (or, if proposal volume warrants,
 * promote this to a dedicated table at that time) and route them through the
 * `merge_nodes` operation. We deliberately do NOT add a `cleanup_proposals`
 * table here — there is no consumer yet and design discipline forbids
 * speculative tables. See `docs/2026-04-24-claims-layer-design.md` §"Dedup /
 * Cleanup".
 *
 * Common aliases: identity reevaluation, background merge proposal,
 * post-ingestion identity sweep, cleanup proposal.
 */
import { resolveIdentity, type IdentityCandidateClaim } from "../identity-resolution";
import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import {
  claims,
  nodeEmbeddings,
  nodeMetadata,
  nodes,
  sourceLinks,
  sources,
} from "~/db/schema";
import {
  type AssertedByKind,
  type NodeType,
  type Predicate,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export interface IdentityReevalJobInput {
  userId: string;
  nodeId: TypeId<"node">;
}

export const IdentityReevalJobInputSchema = z.object({
  userId: z.string().min(1),
  nodeId: z.string().min(1),
});

/**
 * Trustworthy provenance kinds whose claims contribute to profile compat.
 * Mirrors the filter inside `identity-resolution.ts`; we filter at the source
 * here too so the candidate we hand to `resolveIdentity` is already cleaned.
 */
const TRUSTED_PROFILE_KINDS = [
  "user",
  "user_confirmed",
  "system",
] as const satisfies readonly AssertedByKind[];

export type IdentityReevalStatus =
  | "skipped_node_missing"
  | "skipped_no_embedding"
  | "skipped_no_label"
  | "no_proposal"
  | "self_match_only"
  | "merge_proposed";

export interface IdentityReevalResult {
  status: IdentityReevalStatus;
  proposedTargetNodeId?: TypeId<"node">;
}

/**
 * Run identity re-evaluation for a single node.
 *
 * Steps:
 * 1. Load the node (label, type) and its scopes.
 * 2. Load its embedding from `node_embeddings`. If absent, skip.
 * 3. Load trustworthy supporting claims for profile-compat scoring.
 * 4. Build an `IdentityCandidate` and call `resolveIdentity`.
 * 5. If the resolver returns a *different* nodeId, log a `merge_proposal`.
 *    A self-match (the node finding itself via embedding similarity) is
 *    excluded explicitly — the resolver runs against the live graph, so the
 *    input node will appear in its own embedding-similarity result set.
 *
 * No DB mutations.
 */
export async function runIdentityReeval(
  input: IdentityReevalJobInput,
): Promise<IdentityReevalResult> {
  const { userId, nodeId } = input;
  const db = await useDatabase();

  const nodeRow = await _fetchNodeForReeval(db, userId, nodeId);
  if (!nodeRow) return { status: "skipped_node_missing" };
  if (nodeRow.normalizedLabel.length === 0)
    return { status: "skipped_no_label" };

  const embedding = await _fetchNodeEmbedding(db, nodeId);
  if (!embedding) return { status: "skipped_no_embedding" };

  const supportingClaimsForCompat = await _fetchSupportingClaims(
    db,
    userId,
    nodeId,
  );

  const resolution = await resolveIdentity({
    userId,
    candidate: {
      proposedLabel: nodeRow.label ?? nodeRow.normalizedLabel,
      normalizedLabel: nodeRow.normalizedLabel,
      nodeType: nodeRow.nodeType,
      scope: nodeRow.scope,
      embedding,
      supportingClaimsForCompat,
      // The candidate node already lives in the graph, so every signal would
      // otherwise self-match. Exclude it everywhere.
      excludeNodeIds: new Set([nodeId]),
    },
  });

  const target = resolution.resolvedNodeId;
  if (!target) return { status: "no_proposal" };
  if (target === nodeId) {
    // Defensive: the excludeNodeIds filter should make this branch
    // unreachable. Kept as a guard so a future regression in the resolver
    // never produces a self-merge proposal.
    return { status: "self_match_only" };
  }

  // Structured log line. Phase 4 cleanup-graph will consume these. Logged at
  // info so downstream tooling can grep / ship to the structured log sink.
  console.info(
    JSON.stringify({
      event: "identity.merge_proposal",
      userId,
      candidateNodeId: nodeId,
      proposedTargetNodeId: target,
      nodeType: nodeRow.nodeType,
      scope: nodeRow.scope,
      signal: resolution.decision.signal,
      confidence: resolution.decision.confidence,
      trace: resolution.decision.trace,
    }),
  );

  return { status: "merge_proposed", proposedTargetNodeId: target };
}

interface NodeReevalRow {
  label: string | null;
  normalizedLabel: string;
  nodeType: NodeType;
  scope: Scope;
}

/**
 * Load the node's label, type, and scope. The scope is the dominant scope of
 * the node's support: a node with personal-scope support is `personal`;
 * a reference-only node is `reference`. Mirrors the candidate-scope semantics
 * used by `extractGraph` (claims/sources determine scope, not the node).
 */
async function _fetchNodeForReeval(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
): Promise<NodeReevalRow | null> {
  const [row] = await db
    .select({
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      canonicalLabel: nodeMetadata.canonicalLabel,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!row) return null;

  const personal = await _hasScopeSupport(db, userId, nodeId, "personal");
  const scope: Scope = personal
    ? "personal"
    : (await _hasScopeSupport(db, userId, nodeId, "reference"))
      ? "reference"
      : "personal";

  return {
    label: row.label,
    normalizedLabel: row.canonicalLabel ?? "",
    nodeType: row.nodeType,
    scope,
  };
}

async function _hasScopeSupport(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
  scope: Scope,
): Promise<boolean> {
  const sourceLink = db
    .select({ one: sql<number>`1` })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(sourceLinks.nodeId, nodeId),
        eq(sources.userId, userId),
        eq(sources.scope, scope),
      ),
    );
  const claim = db
    .select({ one: sql<number>`1` })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.scope, scope),
        eq(claims.status, "active"),
        or(eq(claims.subjectNodeId, nodeId), eq(claims.objectNodeId, nodeId)),
      ),
    );

  const [row] = await db
    .select({
      supported: sql<boolean>`(${exists(sourceLink)} OR ${exists(claim)})`,
    })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  return row?.supported === true;
}

async function _fetchNodeEmbedding(
  db: DrizzleDB,
  nodeId: TypeId<"node">,
): Promise<number[] | null> {
  const [row] = await db
    .select({ embedding: nodeEmbeddings.embedding })
    .from(nodeEmbeddings)
    .where(eq(nodeEmbeddings.nodeId, nodeId))
    .limit(1);
  return row?.embedding ?? null;
}

async function _fetchSupportingClaims(
  db: DrizzleDB,
  userId: string,
  nodeId: TypeId<"node">,
): Promise<IdentityCandidateClaim[]> {
  const rows = await db
    .select({
      predicate: claims.predicate,
      objectValue: claims.objectValue,
      objectNodeId: claims.objectNodeId,
      assertedByKind: claims.assertedByKind,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.subjectNodeId, nodeId),
        eq(claims.status, "active"),
        eq(claims.scope, "personal"),
        inArray(claims.assertedByKind, [...TRUSTED_PROFILE_KINDS]),
      ),
    );

  return rows.map(
    (row): IdentityCandidateClaim => ({
      predicate: row.predicate as Predicate,
      objectValue: row.objectValue,
      objectNodeId: row.objectNodeId,
      assertedByKind: row.assertedByKind,
    }),
  );
}

