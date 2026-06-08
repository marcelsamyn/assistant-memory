/** Batch-resolve node/claim/source ids to citation-ready records. */
import { resolveNodeRedirects } from "./node-redirects";
import type { ResolvedCitation } from "./schemas/resolve-citations";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, sources } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

type Database =
  | DrizzleDB
  | Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];

function prefixOf(id: string): "node" | "claim" | "src" | "other" {
  if (id.startsWith("node_")) return "node";
  if (id.startsWith("claim_")) return "claim";
  if (id.startsWith("src_")) return "src";
  return "other";
}

function titleFromMetadata(metadata: unknown): string | null {
  if (metadata && typeof metadata === "object" && "title" in metadata) {
    const t = (metadata as { title?: unknown }).title;
    return typeof t === "string" ? t : null;
  }
  return null;
}

/**
 * Resolve a mix of `node_*`/`claim_*`/`src_*` ids. Ids of other namespaces are
 * ignored (other Petals providers own them). Output preserves input order and
 * contains one entry per recognized id.
 */
export async function resolveCitations(
  db: Database,
  userId: string,
  ids: string[],
): Promise<ResolvedCitation[]> {
  const nodeIds = ids.filter((i) => prefixOf(i) === "node") as TypeId<"node">[];
  const claimIds = ids.filter(
    (i) => prefixOf(i) === "claim",
  ) as TypeId<"claim">[];
  const sourceIds = ids.filter(
    (i) => prefixOf(i) === "src",
  ) as TypeId<"source">[];

  // --- nodes: follow merge redirects, then load metadata ---
  const redirects = await resolveNodeRedirects(db, userId, nodeIds);
  const canonicalNodeIds = [...new Set(redirects.values())];
  const nodeRows = canonicalNodeIds.length
    ? await db
        .select({
          id: nodes.id,
          label: nodeMetadata.label,
          description: nodeMetadata.description,
        })
        .from(nodes)
        .leftJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(eq(nodes.userId, userId), inArray(nodes.id, canonicalNodeIds)),
        )
    : [];
  const nodeById = new Map(nodeRows.map((r) => [r.id, r]));
  const nodeCitations: ResolvedCitation[] = nodeIds.map((requestedId) => {
    const canonical = redirects.get(requestedId) ?? requestedId;
    const row = nodeById.get(canonical);
    return {
      requestedId,
      kind: "node",
      available: Boolean(row),
      canonicalId: row ? canonical : null,
      title: row?.label ?? null,
      snippet: row?.description ?? null,
      source: null,
    };
  });

  // --- claims: durable; attach provenance source ---
  const claimRows = claimIds.length
    ? await db
        .select({
          id: claims.id,
          statement: claims.statement,
          description: claims.description,
          sourceId: claims.sourceId,
          sourceType: sources.type,
          sourceMetadata: sources.metadata,
        })
        .from(claims)
        .leftJoin(sources, eq(sources.id, claims.sourceId))
        .where(and(eq(claims.userId, userId), inArray(claims.id, claimIds)))
    : [];
  const claimById = new Map(claimRows.map((r) => [r.id, r]));
  const claimCitations: ResolvedCitation[] = claimIds.map((requestedId) => {
    const row = claimById.get(requestedId);
    return {
      requestedId,
      kind: "claim",
      available: Boolean(row),
      canonicalId: row ? requestedId : null,
      title: row?.statement ?? null,
      snippet: row?.description ?? null,
      source: row
        ? {
            id: row.sourceId,
            title: titleFromMetadata(row.sourceMetadata),
            type: row.sourceType ?? "unknown",
          }
        : null,
    };
  });

  // --- sources: stable; soft-deleted → unavailable ---
  const sourceRows = sourceIds.length
    ? await db
        .select({
          id: sources.id,
          metadata: sources.metadata,
          deletedAt: sources.deletedAt,
        })
        .from(sources)
        .where(and(eq(sources.userId, userId), inArray(sources.id, sourceIds)))
    : [];
  const sourceById = new Map(sourceRows.map((r) => [r.id, r]));
  const sourceCitations: ResolvedCitation[] = sourceIds.map((requestedId) => {
    const row = sourceById.get(requestedId);
    const present = Boolean(row && !row.deletedAt);
    return {
      requestedId,
      kind: "source",
      available: present,
      canonicalId: present ? requestedId : null,
      title: row ? titleFromMetadata(row.metadata) : null,
      snippet: null,
      source: null,
    };
  });

  const byId = new Map<string, ResolvedCitation>(
    [...nodeCitations, ...claimCitations, ...sourceCitations].map((c) => [
      c.requestedId,
      c,
    ]),
  );
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is ResolvedCitation => c !== undefined);
}
