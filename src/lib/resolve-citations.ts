/** Batch-resolve node/claim/source ids to citation-ready records. */
import { resolveNodeRedirects } from "./node-redirects";
import type { ResolvedCitation } from "./schemas/resolve-citations";
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, sources } from "~/db/schema";
import {
  assertPartitionReadAllowed,
  partitionAccessCondition,
} from "~/lib/partition-access";
import type {
  ContextPartitionKey,
  MemoryAccessScope,
} from "~/lib/schemas/partition";
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
  partitionKey?: ContextPartitionKey,
  accessScope: MemoryAccessScope = "partition",
): Promise<ResolvedCitation[]> {
  await assertPartitionReadAllowed(db, userId, partitionKey, accessScope);
  const nodeIds = [
    ...new Set(ids.filter((i) => prefixOf(i) === "node")),
  ] as TypeId<"node">[];
  const claimIds = [
    ...new Set(ids.filter((i) => prefixOf(i) === "claim")),
  ] as TypeId<"claim">[];
  const sourceIds = [
    ...new Set(ids.filter((i) => prefixOf(i) === "src")),
  ] as TypeId<"source">[];

  // --- nodes: follow merge redirects, then load metadata ---
  const redirects = await resolveNodeRedirects(
    db,
    userId,
    nodeIds,
    partitionKey,
    accessScope,
  );
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
          and(
            eq(nodes.userId, userId),
            partitionAccessCondition(
              nodes.partitionKey,
              userId,
              partitionKey,
              accessScope,
            ),
            inArray(nodes.id, canonicalNodeIds),
          ),
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
          partitionKey: claims.partitionKey,
          statement: claims.statement,
          description: claims.description,
          sourceId: claims.sourceId,
          sourcePartitionKey: sources.partitionKey,
          subjectNodeId: claims.subjectNodeId,
          objectNodeId: claims.objectNodeId,
          status: claims.status,
          sourceType: sources.type,
          sourceMetadata: sources.metadata,
        })
        .from(claims)
        .leftJoin(
          sources,
          and(eq(sources.id, claims.sourceId), eq(sources.userId, userId)),
        )
        .where(
          and(
            eq(claims.userId, userId),
            partitionAccessCondition(
              claims.partitionKey,
              userId,
              partitionKey,
              accessScope,
            ),
            inArray(claims.id, claimIds),
          ),
        )
    : [];
  const endpointIds = [
    ...new Set(
      claimRows.flatMap((row) => [
        row.subjectNodeId,
        ...(row.objectNodeId === null ? [] : [row.objectNodeId]),
      ]),
    ),
  ];
  const endpointRows =
    accessScope === "workspace" && endpointIds.length > 0
      ? await db
          .select({ id: nodes.id, partitionKey: nodes.partitionKey })
          .from(nodes)
          .where(
            and(
              eq(nodes.userId, userId),
              partitionAccessCondition(
                nodes.partitionKey,
                userId,
                partitionKey,
                accessScope,
              ),
              inArray(nodes.id, endpointIds),
            ),
          )
      : [];
  const endpointPartitionById = new Map(
    endpointRows.map((row) => [row.id, row.partitionKey]),
  );
  const claimById = new Map(claimRows.map((r) => [r.id, r]));
  const claimCitations: ResolvedCitation[] = claimIds.map((requestedId) => {
    const row = claimById.get(requestedId);
    const endpointsMatch =
      row !== undefined &&
      (row.partitionKey ?? null) ===
        (endpointPartitionById.get(row.subjectNodeId) ?? null) &&
      (row.objectNodeId === null ||
        (row.partitionKey ?? null) ===
          (endpointPartitionById.get(row.objectNodeId) ?? null));
    const sourceMatchesClaim =
      row?.sourceType !== null &&
      row?.sourceType !== undefined &&
      (row.partitionKey ?? null) === (row.sourcePartitionKey ?? null);
    const active =
      row?.status === "active" &&
      (accessScope !== "workspace" || (endpointsMatch && sourceMatchesClaim));
    return {
      requestedId,
      kind: "claim",
      available: active,
      canonicalId: active ? requestedId : null,
      title:
        active || accessScope !== "workspace" ? (row?.statement ?? null) : null,
      snippet:
        active || accessScope !== "workspace"
          ? (row?.description ?? null)
          : null,
      source:
        (active || accessScope !== "workspace") && row && sourceMatchesClaim
          ? {
              id: row.sourceId,
              title: titleFromMetadata(row.sourceMetadata),
              type: row.sourceType ?? "unknown",
            }
          : null,
      subjectNodeId:
        active || accessScope !== "workspace"
          ? (row?.subjectNodeId ?? null)
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
        .where(
          and(
            eq(sources.userId, userId),
            partitionAccessCondition(
              sources.partitionKey,
              userId,
              partitionKey,
              accessScope,
            ),
            inArray(sources.id, sourceIds),
          ),
        )
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
      title:
        (present || accessScope !== "workspace") && row
          ? titleFromMetadata(row.metadata)
          : null,
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
