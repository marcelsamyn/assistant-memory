/**
 * Effective node scope resolution.
 *
 * A node is `reference` only if every reachable scope signal is `reference`:
 * every `claims.scope` value among claims where the node is subject or object,
 * AND every `sources.scope` reachable via `source_links`. Any single personal
 * signal flips the node to `personal`. Nodes with no claims and no source
 * links default to `personal` (matches the column default).
 *
 * Common aliases: effective scope, node scope resolution, scope-bounded merge.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodes, sourceLinks, sources } from "~/db/schema";
import type { Scope } from "~/types/graph";
import type { TypeId } from "~/types/typeid";

/**
 * Compute the effective scope per node id for the given user. Returns a map
 * keyed by node id. Nodes that don't belong to the user are omitted; callers
 * should validate ownership separately when needed.
 */
export async function getEffectiveNodeScopes(
  database: DrizzleDB,
  userId: string,
  nodeIds: ReadonlyArray<TypeId<"node">>,
): Promise<Map<TypeId<"node">, Scope>> {
  const result = new Map<TypeId<"node">, Scope>();
  if (nodeIds.length === 0) return result;
  const uniqueIds = [...new Set(nodeIds)];

  const rows = await database
    .select({
      nodeId: nodes.id,
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
    .leftJoin(
      claims,
      and(
        eq(claims.userId, userId),
        sql`(${claims.subjectNodeId} = ${nodes.id} OR ${claims.objectNodeId} = ${nodes.id})`,
      ),
    )
    .leftJoin(sourceLinks, eq(sourceLinks.nodeId, nodes.id))
    .leftJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, uniqueIds)))
    .groupBy(nodes.id);

  for (const row of rows) {
    const hasAnyPersonal = row.hasPersonalClaim || row.hasPersonalSource;
    const hasAnyReference = row.hasReferenceClaim || row.hasReferenceSource;
    result.set(
      row.nodeId,
      !hasAnyPersonal && hasAnyReference ? "reference" : "personal",
    );
  }
  return result;
}
