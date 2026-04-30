/** Deterministic dedup sweep: finds exact-label duplicate nodes and merges them.
 *
 * Scope-bounded: nodes with the same canonical label but different effective
 * scope (`personal` vs `reference`) are not merged. Such collisions are logged
 * and counted under `crossScopeCollisionsSkipped`.
 */
import {
  rewireNodeClaims,
  rewireSourceLinks,
  deleteNode,
} from "./cleanup-graph";
import { and, eq, sql, isNotNull } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { nodes, nodeMetadata, claims, sourceLinks, sources } from "~/db/schema";
import type { Scope } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

interface DuplicateGroup {
  nodeType: string;
  canonicalLabel: string;
  effectiveScope: Scope;
  nodeIds: TypeId<"node">[];
}

interface CrossScopeCollision {
  nodeType: string;
  canonicalLabel: string;
  scopes: Scope[];
}

interface DuplicateGroupingResult {
  groups: DuplicateGroup[];
  crossScopeCollisions: CrossScopeCollision[];
}

/**
 * Compute effective scope per node and group duplicates by
 * `(nodeType, canonicalLabel, effectiveScope)`.
 *
 * A node is `reference` only if every reachable scope signal is `reference`:
 * every `claims.scope` value among claims where the node is subject or object,
 * AND every `sources.scope` reachable via `source_links`. Any single personal
 * signal flips the node to `personal`. Nodes with no claims and no source
 * links default to `personal`.
 *
 * Cross-scope label collisions (same `(nodeType, canonicalLabel)` present with
 * both `personal` and `reference` effective scopes) are reported separately
 * and never merged.
 */
async function findDuplicateGroupingsByScope(
  db: DrizzleDB,
  userId: string,
): Promise<DuplicateGroupingResult> {
  // Per-node effective scope. A node is 'reference' iff every claim and every
  // source it touches is 'reference'. Personal evidence wins; absence of any
  // signal also defaults to 'personal' (matches the column default).
  //
  // Unresolved-speaker placeholder Persons are excluded entirely: two
  // placeholders with the same label "Alex" from different transcripts often
  // refer to different real people, so collapsing them by label alone would
  // destroy distinct identities ("speaker placeholder explosion" trap).
  const scopeRows = await db
    .select({
      nodeId: nodes.id,
      nodeType: nodes.nodeType,
      canonicalLabel: nodeMetadata.canonicalLabel,
      hasPersonalClaim: sql<boolean>`bool_or(
        ${claims.id} IS NOT NULL AND ${claims.scope} = 'personal'
      )`.as("has_personal_claim"),
      hasReferenceClaim: sql<boolean>`bool_or(
        ${claims.id} IS NOT NULL AND ${claims.scope} = 'reference'
      )`.as("has_reference_claim"),
      hasPersonalSource: sql<boolean>`bool_or(
        ${sources.id} IS NOT NULL AND ${sources.scope} = 'personal'
      )`.as("has_personal_source"),
      hasReferenceSource: sql<boolean>`bool_or(
        ${sources.id} IS NOT NULL AND ${sources.scope} = 'reference'
      )`.as("has_reference_source"),
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(
      claims,
      and(
        eq(claims.userId, userId),
        sql`(${claims.subjectNodeId} = ${nodes.id} OR ${claims.objectNodeId} = ${nodes.id})`,
      ),
    )
    .leftJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
    .leftJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(
      and(
        eq(nodes.userId, userId),
        isNotNull(nodeMetadata.canonicalLabel),
        sql`trim(${nodeMetadata.canonicalLabel}) != ''`,
        sql`(${nodeMetadata.additionalData} ->> 'unresolvedSpeaker') IS DISTINCT FROM 'true'`,
      ),
    )
    .groupBy(nodes.id, nodes.nodeType, nodeMetadata.canonicalLabel);

  type GroupKey = string;
  const groupBuckets = new Map<
    GroupKey,
    {
      nodeType: string;
      canonicalLabel: string;
      effectiveScope: Scope;
      nodeIds: TypeId<"node">[];
    }
  >();
  const scopesByLabel = new Map<string, Set<Scope>>();

  for (const row of scopeRows) {
    if (!row.canonicalLabel) continue;
    const hasAnyPersonal = row.hasPersonalClaim || row.hasPersonalSource;
    const hasAnyReference = row.hasReferenceClaim || row.hasReferenceSource;
    const effectiveScope: Scope =
      !hasAnyPersonal && hasAnyReference ? "reference" : "personal";

    const labelKey = `${row.nodeType}::${row.canonicalLabel}`;
    const labelScopes = scopesByLabel.get(labelKey) ?? new Set<Scope>();
    labelScopes.add(effectiveScope);
    scopesByLabel.set(labelKey, labelScopes);

    const groupKey = `${labelKey}::${effectiveScope}`;
    const bucket = groupBuckets.get(groupKey);
    if (bucket) {
      bucket.nodeIds.push(row.nodeId);
    } else {
      groupBuckets.set(groupKey, {
        nodeType: row.nodeType,
        canonicalLabel: row.canonicalLabel,
        effectiveScope,
        nodeIds: [row.nodeId],
      });
    }
  }

  const groups: DuplicateGroup[] = [];
  for (const bucket of groupBuckets.values()) {
    if (bucket.nodeIds.length < 2) continue;
    // Stable order: oldest first wins. We didn't sort by createdAt above, so
    // re-sort by node id (typeid is k-sortable by creation time).
    bucket.nodeIds.sort();
    groups.push(bucket);
  }

  const crossScopeCollisions: CrossScopeCollision[] = [];
  for (const [labelKey, scopeSet] of scopesByLabel) {
    if (scopeSet.size < 2) continue;
    const sep = labelKey.indexOf("::");
    const nodeType = labelKey.slice(0, sep);
    const canonicalLabel = labelKey.slice(sep + 2);
    crossScopeCollisions.push({
      nodeType,
      canonicalLabel,
      scopes: [...scopeSet].sort(),
    });
  }

  return { groups, crossScopeCollisions };
}

/**
 * Merge a group of duplicate nodes: keep the oldest (first), rewire and delete the rest.
 */
async function mergeGroup(
  tx: DrizzleDB,
  userId: string,
  group: DuplicateGroup,
): Promise<number> {
  const [keepId, ...removeIds] = group.nodeIds;
  if (!keepId || removeIds.length === 0) return 0;

  for (const removeId of removeIds) {
    await rewireNodeClaims(tx, removeId, keepId, userId);
    await rewireSourceLinks(tx, removeId, keepId);
    await deleteNode(tx, removeId, userId);
  }

  return removeIds.length;
}

export interface DedupSweepResult {
  mergedGroups: number;
  mergedNodes: number;
  crossScopeCollisionsSkipped: number;
}

/**
 * Run a full dedup sweep for a user: find all exact-label duplicates within
 * the same effective scope and merge them. Cross-scope label collisions are
 * skipped and reported.
 */
export async function runDedupSweep(
  userId: string,
  dbOverride?: DrizzleDB,
): Promise<DedupSweepResult> {
  const db = dbOverride ?? (await useDatabase());
  const { groups, crossScopeCollisions } = await findDuplicateGroupingsByScope(
    db,
    userId,
  );

  if (crossScopeCollisions.length > 0) {
    const sample = crossScopeCollisions.slice(0, 5).map((c) => ({
      label: c.canonicalLabel,
      type: c.nodeType,
      scopes: c.scopes,
    }));
    console.warn(
      `[dedup-sweep] cross_scope_label_collision count=${crossScopeCollisions.length} sample=${JSON.stringify(
        sample,
      )} user=${userId}`,
    );
  }

  if (groups.length === 0) {
    console.log(`[dedup-sweep] No duplicates found for user ${userId}`);
    return {
      mergedGroups: 0,
      mergedNodes: 0,
      crossScopeCollisionsSkipped: crossScopeCollisions.length,
    };
  }

  console.log(
    `[dedup-sweep] Found ${groups.length} duplicate groups for user ${userId}`,
  );

  let totalMerged = 0;

  await db.transaction(async (tx) => {
    for (const group of groups) {
      const merged = await mergeGroup(tx, userId, group);
      totalMerged += merged;
      console.log(
        `[dedup-sweep] Merged ${merged} duplicates of "${group.canonicalLabel}" (${group.nodeType}, scope=${group.effectiveScope})`,
      );
    }
  });

  console.log(
    `[dedup-sweep] Completed: ${groups.length} groups, ${totalMerged} nodes merged for user ${userId}`,
  );

  return {
    mergedGroups: groups.length,
    mergedNodes: totalMerged,
    crossScopeCollisionsSkipped: crossScopeCollisions.length,
  };
}
