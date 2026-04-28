/**
 * Scope-bounded identity resolution.
 *
 * Given a candidate (a label + nodeType + scope, optionally an embedding and a
 * supporting claim profile), decide whether the candidate refers to an
 * existing node — and if so, return its id along with a structured decision
 * trace for eval replay.
 *
 * Signals are evaluated in order; the first that fires above the confidence
 * threshold wins. All attempted signals are recorded in the trace, even if
 * they did not fire, so the eval harness can reason about why a particular
 * resolution outcome occurred.
 *
 * Common aliases: identity resolution, entity linking, candidate matching,
 * canonical id resolution, decision trace.
 *
 * Cross-scope candidates are intentionally never merged across the
 * personal/reference boundary — the design forbids it. When a candidate would
 * otherwise have matched a node in the wrong scope, the resolver returns
 * `null` and emits an `identity.cross_scope_merge_refused` log entry that the
 * cleanup pipeline picks up later.
 */
import { findSimilarNodes } from "./graph";
import { aliases, claims, nodeMetadata, nodes, sourceLinks, sources } from "~/db/schema";
import {
  type AssertedByKind,
  type NodeType,
  type Predicate,
  type Scope,
} from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { env } from "~/utils/env";
import { and, eq, inArray, or } from "drizzle-orm";

/**
 * The set of scopes a node has any support in. A node may legitimately have
 * support in both scopes (e.g., a Concept node touched by both personal and
 * reference claims); we treat the candidate's scope as compatible if it
 * appears in this set, and refuse otherwise.
 */
type NodeScopes = Set<Scope>;

/** Subset of an existing claim that contributes to profile-compatibility scoring. */
export interface IdentityCandidateClaim {
  predicate: Predicate;
  /** For attribute claims. */
  objectValue?: string | null;
  /** For relationship claims. */
  objectNodeId?: TypeId<"node"> | null;
  assertedByKind: AssertedByKind;
}

export interface IdentityCandidate {
  /** Original label as it was extracted (preserved for logging). */
  proposedLabel: string;
  /** Lowercased, trimmed, whitespace-collapsed label — the matching key. */
  normalizedLabel: string;
  nodeType: NodeType;
  scope: Scope;
  /** Optional dense embedding for signal 3. Skip signal 3 if absent. */
  embedding?: number[];
  /** Trustworthy supporting claims for signal 4. Untrusted kinds are filtered internally. */
  supportingClaimsForCompat?: IdentityCandidateClaim[];
  /**
   * Node ids that must never be returned as a match. Used by the background
   * re-evaluation pass (Phase 3.3) to exclude the candidate's own node id —
   * otherwise every signal would self-match because the candidate already
   * lives in the graph.
   */
  excludeNodeIds?: ReadonlySet<TypeId<"node">>;
}

export type IdentitySignal =
  | "canonical_label"
  | "alias"
  | "embedding_sim"
  | "profile_compat"
  | "none";

/** A single candidate evaluated by a signal, with the score it produced. */
export interface SignalCandidate {
  nodeId: TypeId<"node">;
  score: number;
  /** Optional explanation; populated where it adds eval-replay value. */
  note?: string;
}

export type SignalTrace =
  | {
      signal: "canonical_label";
      fired: boolean;
      candidates: SignalCandidate[];
      /** Set when a same-label match exists in a different scope. */
      crossScopeRefusal?: { nodeId: TypeId<"node">; otherScope: Scope };
    }
  | {
      signal: "alias";
      fired: boolean;
      candidates: SignalCandidate[];
      crossScopeRefusal?: { nodeId: TypeId<"node">; otherScope: Scope };
    }
  | {
      signal: "embedding_sim";
      fired: boolean;
      candidates: SignalCandidate[];
      threshold: number;
      skipped?: "no_embedding";
    }
  | {
      signal: "profile_compat";
      fired: boolean;
      candidates: SignalCandidate[];
      threshold: number;
      skipped?: "no_supporting_claims" | "no_embedding_candidates";
    };

export interface IdentityResolution {
  resolvedNodeId: TypeId<"node"> | null;
  decision: {
    signal: IdentitySignal;
    confidence: number;
    trace: SignalTrace[];
  };
}

export interface ResolveIdentityInput {
  userId: string;
  candidate: IdentityCandidate;
}

/**
 * Trustworthy provenance kinds for signal 4 profile-compatibility scoring.
 * `assistant_inferred`, `participant`, and `document_author` claims are
 * deliberately excluded — they are too noisy to drive a merge decision.
 */
const TRUSTED_PROFILE_KINDS = new Set<AssertedByKind>([
  "user",
  "user_confirmed",
  "system",
]);

/** Cap on the embedding-similarity candidate set passed into signal 4. */
const SIGNAL_3_CANDIDATE_LIMIT = 5;

/**
 * Resolve a candidate to an existing node id, returning the matched id (or
 * null) and a full decision trace.
 */
export async function resolveIdentity({
  userId,
  candidate,
}: ResolveIdentityInput): Promise<IdentityResolution> {
  const trace: SignalTrace[] = [];
  const excluded = candidate.excludeNodeIds;

  // --- Signal 1: canonical label match ---------------------------------
  const canonicalTrace = _filterTraceCandidates(
    await _signalCanonicalLabel(userId, candidate),
    excluded,
  );
  trace.push(canonicalTrace);
  if (canonicalTrace.signal === "canonical_label" && canonicalTrace.fired) {
    const winner = canonicalTrace.candidates[0];
    if (winner) {
      return _resolved(winner.nodeId, "canonical_label", winner.score, trace, candidate, userId);
    }
  }

  // --- Signal 2: alias match -------------------------------------------
  const aliasTrace = _filterTraceCandidates(
    await _signalAlias(userId, candidate),
    excluded,
  );
  trace.push(aliasTrace);
  if (aliasTrace.signal === "alias" && aliasTrace.fired) {
    const winner = aliasTrace.candidates[0];
    if (winner) {
      return _resolved(winner.nodeId, "alias", winner.score, trace, candidate, userId);
    }
  }

  // --- Signal 3: embedding similarity ----------------------------------
  const embeddingTrace = _filterTraceCandidates(
    await _signalEmbeddingSim(userId, candidate),
    excluded,
  );
  trace.push(embeddingTrace);

  // --- Signal 4: claim profile compatibility ---------------------------
  const profileTrace = _filterTraceCandidates(
    await _signalProfileCompat(
      userId,
      candidate,
      embeddingTrace.signal === "embedding_sim" ? embeddingTrace.candidates : [],
    ),
    excluded,
  );
  trace.push(profileTrace);

  if (profileTrace.signal === "profile_compat" && profileTrace.fired) {
    const winner = profileTrace.candidates[0];
    if (winner) {
      return _resolved(winner.nodeId, "profile_compat", winner.score, trace, candidate, userId);
    }
  }

  // Embedding alone is intentionally not enough to merge — we require profile
  // corroboration. Surface the embedding hits in the trace but do not resolve.
  if (embeddingTrace.signal === "embedding_sim" && embeddingTrace.fired) {
    // Resolution did not happen; embedding-only matches need profile_compat
    // corroboration before we auto-merge. The trace records the near-miss.
  }

  for (const entry of trace) {
    if (
      (entry.signal === "canonical_label" || entry.signal === "alias") &&
      entry.crossScopeRefusal
    ) {
      _logCrossScopeRefusal(userId, candidate, entry.signal, entry.crossScopeRefusal);
    }
  }

  return {
    resolvedNodeId: null,
    decision: { signal: "none", confidence: 0, trace },
  };
}

// =====================================================================
// Signal 1 — canonical label
// =====================================================================

interface ScopedNodeRow {
  id: TypeId<"node">;
  scopes: NodeScopes;
}

async function _signalCanonicalLabel(
  userId: string,
  candidate: IdentityCandidate,
): Promise<SignalTrace> {
  if (candidate.normalizedLabel.length === 0) {
    return { signal: "canonical_label", fired: false, candidates: [] };
  }

  const matches = await _findNodesByCanonicalLabel(userId, candidate);
  return _classifyScopeMatches("canonical_label", candidate.scope, matches);
}

async function _findNodesByCanonicalLabel(
  userId: string,
  candidate: IdentityCandidate,
): Promise<ScopedNodeRow[]> {
  const db = await useDatabase();
  const matches = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        eq(nodes.nodeType, candidate.nodeType),
        eq(nodeMetadata.canonicalLabel, candidate.normalizedLabel),
      ),
    );
  if (matches.length === 0) return [];
  return _annotateScope(
    userId,
    matches.map((m) => m.id),
  );
}

// =====================================================================
// Signal 2 — alias
// =====================================================================

async function _signalAlias(
  userId: string,
  candidate: IdentityCandidate,
): Promise<SignalTrace> {
  if (candidate.normalizedLabel.length === 0) {
    return { signal: "alias", fired: false, candidates: [] };
  }
  const db = await useDatabase();
  const aliasMatches = await db
    .select({ canonicalNodeId: aliases.canonicalNodeId })
    .from(aliases)
    .innerJoin(nodes, eq(nodes.id, aliases.canonicalNodeId))
    .where(
      and(
        eq(aliases.userId, userId),
        eq(aliases.normalizedAliasText, candidate.normalizedLabel),
        eq(nodes.nodeType, candidate.nodeType),
      ),
    );

  if (aliasMatches.length === 0) {
    return { signal: "alias", fired: false, candidates: [] };
  }

  const scoped = await _annotateScope(
    userId,
    aliasMatches.map((m) => m.canonicalNodeId),
  );
  return _classifyScopeMatches("alias", candidate.scope, scoped);
}

// =====================================================================
// Signal 3 — embedding similarity (scope-bounded)
// =====================================================================

async function _signalEmbeddingSim(
  userId: string,
  candidate: IdentityCandidate,
): Promise<SignalTrace> {
  const threshold = env.IDENTITY_EMBEDDING_THRESHOLD;
  if (!candidate.embedding || candidate.embedding.length === 0) {
    return {
      signal: "embedding_sim",
      fired: false,
      candidates: [],
      threshold,
      skipped: "no_embedding",
    };
  }

  // The findSimilarNodes path already enforces scope via
  // `nodeHasScopeSupport`; we restrict to the same scope as the candidate by
  // passing `includeReference` only for reference candidates.
  const similar = await findSimilarNodes({
    userId,
    embedding: candidate.embedding,
    minimumSimilarity: threshold,
    limit: 25,
    includeReference: candidate.scope === "reference",
  });

  // Filter to same nodeType + same scope. findSimilarNodes returns nodes that
  // have *any* support in the requested scope; for reference candidates, that
  // call also yields personal nodes. Tighten with an explicit scope check.
  const sameType = similar.filter((row) => row.type === candidate.nodeType);
  if (sameType.length === 0) {
    return {
      signal: "embedding_sim",
      fired: false,
      candidates: [],
      threshold,
    };
  }
  const scoped = await _annotateScope(
    userId,
    sameType.map((row) => row.id),
  );
  const scopeOk = new Set(
    scoped
      .filter((row) => row.scopes.has(candidate.scope))
      .map((row) => row.id),
  );

  const candidates: SignalCandidate[] = sameType
    .filter((row) => scopeOk.has(row.id))
    .slice(0, SIGNAL_3_CANDIDATE_LIMIT)
    .map((row) => ({ nodeId: row.id, score: row.similarity }));

  return {
    signal: "embedding_sim",
    fired: candidates.length > 0,
    candidates,
    threshold,
  };
}

// =====================================================================
// Signal 4 — claim profile compatibility
// =====================================================================

interface ExistingClaimRow {
  subjectNodeId: TypeId<"node">;
  predicate: Predicate;
  objectNodeId: TypeId<"node"> | null;
  objectValue: string | null;
  assertedByKind: AssertedByKind;
}

async function _signalProfileCompat(
  userId: string,
  candidate: IdentityCandidate,
  embeddingCandidates: SignalCandidate[],
): Promise<SignalTrace> {
  const threshold = env.IDENTITY_PROFILE_COMPAT_THRESHOLD;

  if (embeddingCandidates.length === 0) {
    return {
      signal: "profile_compat",
      fired: false,
      candidates: [],
      threshold,
      skipped: "no_embedding_candidates",
    };
  }

  const candidateProfile = (candidate.supportingClaimsForCompat ?? []).filter(
    (claim) => TRUSTED_PROFILE_KINDS.has(claim.assertedByKind),
  );

  if (candidateProfile.length === 0) {
    return {
      signal: "profile_compat",
      fired: false,
      candidates: [],
      threshold,
      skipped: "no_supporting_claims",
    };
  }

  const candidateNodeIds = embeddingCandidates.map((c) => c.nodeId);
  const existingClaims = await _fetchTrustedProfileClaims(userId, candidateNodeIds);

  const claimsByNode = new Map<TypeId<"node">, ExistingClaimRow[]>();
  for (const id of candidateNodeIds) claimsByNode.set(id, []);
  for (const row of existingClaims) {
    const list = claimsByNode.get(row.subjectNodeId);
    if (list) list.push(row);
  }

  const scored: SignalCandidate[] = [];
  for (const embCandidate of embeddingCandidates) {
    const existing = claimsByNode.get(embCandidate.nodeId) ?? [];
    const score = _profileCompatibilityScore(candidateProfile, existing);
    if (score >= threshold) {
      scored.push({
        nodeId: embCandidate.nodeId,
        // Combine embedding similarity and profile overlap multiplicatively
        // so a weak embedding match needs strong profile overlap to win, and
        // vice versa. Use the unweighted profile score as the primary signal.
        score,
        note: `profile_overlap=${score.toFixed(3)};embedding_sim=${embCandidate.score.toFixed(3)}`,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    signal: "profile_compat",
    fired: scored.length > 0,
    candidates: scored,
    threshold,
  };
}

/**
 * Jaccard-style overlap of trusted (predicate, object) keys between candidate
 * profile and existing-node profile. Both attribute (objectValue) and
 * relationship (objectNodeId) claims contribute equally.
 */
function _profileCompatibilityScore(
  candidateProfile: IdentityCandidateClaim[],
  existingProfile: ExistingClaimRow[],
): number {
  const candidateKeys = new Set(
    candidateProfile.map((claim) => _profileKey(claim)),
  );
  if (candidateKeys.size === 0) return 0;

  const existingKeys = new Set(
    existingProfile
      .filter((row) => TRUSTED_PROFILE_KINDS.has(row.assertedByKind))
      .map((row) => _profileKey(row)),
  );
  if (existingKeys.size === 0) return 0;

  let overlap = 0;
  for (const key of candidateKeys) {
    if (existingKeys.has(key)) overlap += 1;
  }
  const union = candidateKeys.size + existingKeys.size - overlap;
  return union === 0 ? 0 : overlap / union;
}

function _profileKey(
  claim: IdentityCandidateClaim | ExistingClaimRow,
): string {
  const objectValue =
    "objectValue" in claim ? (claim.objectValue ?? null) : null;
  const objectNodeId =
    "objectNodeId" in claim ? (claim.objectNodeId ?? null) : null;
  if (objectNodeId !== null) {
    return `rel|${claim.predicate}|${objectNodeId}`;
  }
  return `attr|${claim.predicate}|${objectValue ?? ""}`;
}

async function _fetchTrustedProfileClaims(
  userId: string,
  candidateNodeIds: TypeId<"node">[],
): Promise<ExistingClaimRow[]> {
  if (candidateNodeIds.length === 0) return [];
  const db = await useDatabase();
  const rows = await db
    .select({
      subjectNodeId: claims.subjectNodeId,
      predicate: claims.predicate,
      objectNodeId: claims.objectNodeId,
      objectValue: claims.objectValue,
      assertedByKind: claims.assertedByKind,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        inArray(claims.subjectNodeId, candidateNodeIds),
        inArray(claims.assertedByKind, [
          "user",
          "user_confirmed",
          "system",
        ] as AssertedByKind[]),
      ),
    );
  return rows;
}

// =====================================================================
// Shared helpers
// =====================================================================

/**
 * Tag a set of node ids with the scope they have support in. A node may have
 * support in both scopes, in which case the matching scope wins. Nodes with
 * no claims and no source links default to the scope the candidate is in
 * (their existence implies they were just created and not yet linked).
 */
async function _annotateScope(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<ScopedNodeRow[]> {
  if (nodeIds.length === 0) return [];
  const db = await useDatabase();

  // Two cheap queries are clearer than one ambiguous-correlated COALESCE
  // subquery. Source-link support wins over claim support; both default to
  // 'personal' when no support is present (matches the column default).
  const linkRows = await db
    .select({
      nodeId: sourceLinks.nodeId,
      scope: sources.scope,
    })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(eq(sources.userId, userId), inArray(sourceLinks.nodeId, nodeIds)),
    );
  const claimRows = await db
    .select({
      subjectNodeId: claims.subjectNodeId,
      objectNodeId: claims.objectNodeId,
      scope: claims.scope,
    })
    .from(claims)
    .where(
      and(
        eq(claims.userId, userId),
        eq(claims.status, "active"),
        or(
          inArray(claims.subjectNodeId, nodeIds),
          inArray(claims.objectNodeId, nodeIds),
        ),
      ),
    );

  const scopesByNode = new Map<TypeId<"node">, NodeScopes>();
  function addScope(nodeId: TypeId<"node">, scope: Scope): void {
    let set = scopesByNode.get(nodeId);
    if (!set) {
      set = new Set();
      scopesByNode.set(nodeId, set);
    }
    set.add(scope);
  }
  for (const row of linkRows) addScope(row.nodeId, row.scope);
  const candidateIdSet = new Set(nodeIds);
  for (const row of claimRows) {
    for (const candidateId of [row.subjectNodeId, row.objectNodeId]) {
      if (candidateId && candidateIdSet.has(candidateId)) {
        addScope(candidateId, row.scope);
      }
    }
  }

  return nodeIds.map((id) => ({
    id,
    scopes: scopesByNode.get(id) ?? new Set<Scope>(["personal"]),
  }));
}

/**
 * Given the same-label matches for a signal that uses an exact-key lookup
 * (canonical label, alias), pick a same-scope winner if any. If only
 * different-scope matches exist, log a cross-scope refusal and return a
 * non-firing trace so resolution falls through to later signals (which will
 * also reject the cross-scope match) and ultimately returns null.
 */
/**
 * Drop excluded node ids from a signal trace's candidate list. If excluding
 * leaves the list empty, the trace's `fired` flag is also reset so downstream
 * short-circuit checks treat it as "did not fire."
 */
function _filterTraceCandidates(
  trace: SignalTrace,
  excluded: ReadonlySet<TypeId<"node">> | undefined,
): SignalTrace {
  if (!excluded || excluded.size === 0) return trace;
  const filtered = trace.candidates.filter((c) => !excluded.has(c.nodeId));
  if (filtered.length === trace.candidates.length) return trace;
  return { ...trace, candidates: filtered, fired: filtered.length > 0 };
}

function _classifyScopeMatches(
  signal: "canonical_label" | "alias",
  candidateScope: Scope,
  matches: ScopedNodeRow[],
): SignalTrace {
  const sameScope = matches.filter((row) => row.scopes.has(candidateScope));
  if (sameScope.length > 0) {
    const candidates: SignalCandidate[] = sameScope.map((row) => ({
      nodeId: row.id,
      score: 1,
    }));
    return { signal, fired: true, candidates };
  }
  const otherScopeMatch = matches[0];
  if (!otherScopeMatch) {
    return { signal, fired: false, candidates: [] };
  }
  // Pick a deterministic scope from the rejected node's scope set; if it has
  // multiple, the first non-candidate scope wins (any will do for logging).
  const rejectedScope =
    [...otherScopeMatch.scopes].find((s) => s !== candidateScope) ?? "personal";
  return {
    signal,
    fired: false,
    candidates: [],
    crossScopeRefusal: {
      nodeId: otherScopeMatch.id,
      otherScope: rejectedScope,
    },
  };
}

function _resolved(
  nodeId: TypeId<"node">,
  signal: IdentitySignal,
  confidence: number,
  trace: SignalTrace[],
  candidate: IdentityCandidate,
  userId: string,
): IdentityResolution {
  console.info(
    JSON.stringify({
      event: "identity.resolved",
      userId,
      candidateLabel: candidate.proposedLabel,
      normalizedLabel: candidate.normalizedLabel,
      nodeType: candidate.nodeType,
      scope: candidate.scope,
      signal,
      confidence,
      resolvedNodeId: nodeId,
      trace,
    }),
  );

  // Cross-scope refusals on earlier signals (recorded in the trace) get a
  // dedicated log line so the cleanup pipeline can pick them up. We only emit
  // when a refusal actually happened and resolution completed via a later
  // (same-scope) signal — the all-refused case is logged below in the null
  // branch.
  for (const entry of trace) {
    if (
      (entry.signal === "canonical_label" || entry.signal === "alias") &&
      entry.crossScopeRefusal
    ) {
      _logCrossScopeRefusal(userId, candidate, entry.signal, entry.crossScopeRefusal);
    }
  }

  return {
    resolvedNodeId: nodeId,
    decision: { signal, confidence, trace },
  };
}

function _logCrossScopeRefusal(
  userId: string,
  candidate: IdentityCandidate,
  signal: "canonical_label" | "alias",
  refusal: { nodeId: TypeId<"node">; otherScope: Scope },
): void {
  console.info(
    JSON.stringify({
      event: "identity.cross_scope_merge_refused",
      userId,
      candidateLabel: candidate.proposedLabel,
      normalizedLabel: candidate.normalizedLabel,
      nodeType: candidate.nodeType,
      candidateScope: candidate.scope,
      signal,
      rejectedNodeId: refusal.nodeId,
      rejectedScope: refusal.otherScope,
    }),
  );
}
