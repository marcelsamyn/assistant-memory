/** Node operations: get, get sources, update, delete. */
import type {
  GetNodeClaimFilter,
  GetNodeResponse,
  GetNodeSourcesResponse,
} from "./schemas/node";
import { format } from "date-fns";
import { and, eq, or, inArray, aliasedTable, sql } from "drizzle-orm";
import {
  nodes,
  nodeMetadata,
  nodeEmbeddings,
  claims,
  sourceLinks,
  sources,
} from "~/db/schema";
import { listAliasesForNodeIds } from "~/lib/alias";
import { createClaim } from "~/lib/claim";
import { generateEmbeddings } from "~/lib/embeddings";
import { generateAndInsertNodeEmbeddings } from "~/lib/embeddings-util";
import {
  fetchSourceIdsForNodes,
  findOneHopNodes,
  fetchClaimsBetweenNodeIds,
} from "~/lib/graph";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { normalizeLabel } from "~/lib/label";
import { getEffectiveNodeScopes } from "~/lib/node-scope";
import { ensureSystemSource, sourceService } from "~/lib/sources";
import { ensureDayNode } from "~/lib/temporal";
import type { AssertedByKind, NodeType, Predicate, Scope } from "~/types/graph";
import type { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

/**
 * Thrown when a merge spans nodes whose effective scope is not uniform
 * (a personal node and a reference node share the candidate set). Cleanup
 * paths catch this and skip the merge; the route surface translates it
 * into a 4xx.
 */
export class CrossScopeMergeError extends Error {
  readonly nodeIds: ReadonlyArray<TypeId<"node">>;
  readonly scopes: ReadonlyArray<Scope>;
  constructor(
    nodeIds: ReadonlyArray<TypeId<"node">>,
    scopes: ReadonlyArray<Scope>,
  ) {
    super(
      `Cross-scope merge refused: candidates span scopes [${[...scopes].sort().join(", ")}]`,
    );
    this.name = "CrossScopeMergeError";
    this.nodeIds = nodeIds;
    this.scopes = scopes;
  }
}

/**
 * Read the `unresolvedSpeaker` boolean from a `node_metadata.additional_data`
 * JSONB blob defensively. Anything other than a literal `true` returns false.
 */
function readUnresolvedSpeakerFlag(additionalData: unknown): boolean {
  if (
    additionalData &&
    typeof additionalData === "object" &&
    !Array.isArray(additionalData)
  ) {
    return (
      (additionalData as Record<string, unknown>)["unresolvedSpeaker"] === true
    );
  }
  return false;
}

/**
 * Fetch a single node by ID with claims and source IDs.
 *
 * By default only `active` claims are returned, matching the historical
 * behaviour. Callers can pass `claimFilter` to narrow by predicate or to
 * include non-active claims (e.g. `superseded`, `retracted`) when they need
 * lifecycle history.
 */
export async function getNodeById(
  userId: string,
  nodeId: TypeId<"node">,
  claimFilter?: GetNodeClaimFilter,
): Promise<GetNodeResponse | null> {
  const db = await useDatabase();

  const [row] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      createdAt: nodes.createdAt,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!row) return null;

  // Fetch all active claims touching this node (subject or object).
  const srcMeta = aliasedTable(nodeMetadata, "srcMeta");
  const tgtMeta = aliasedTable(nodeMetadata, "tgtMeta");

  const predicateFilter =
    claimFilter?.predicates && claimFilter.predicates.length > 0
      ? inArray(claims.predicate, claimFilter.predicates)
      : undefined;
  // An explicit empty `statuses: []` is treated as "no status constraint",
  // so callers can opt into the full lifecycle history; omitting the field
  // (or passing only "active") preserves the historical default.
  const statusFilter =
    claimFilter?.statuses === undefined
      ? eq(claims.status, "active")
      : claimFilter.statuses.length === 0
        ? undefined
        : inArray(claims.status, claimFilter.statuses);

  const claimRows = await db
    .select({
      id: claims.id,
      subjectNodeId: claims.subjectNodeId,
      objectNodeId: claims.objectNodeId,
      objectValue: claims.objectValue,
      predicate: claims.predicate,
      statement: claims.statement,
      description: claims.description,
      subjectLabel: srcMeta.label,
      objectLabel: tgtMeta.label,
      sourceId: claims.sourceId,
      scope: claims.scope,
      assertedByKind: claims.assertedByKind,
      assertedByNodeId: claims.assertedByNodeId,
      status: claims.status,
      statedAt: claims.statedAt,
    })
    .from(claims)
    .leftJoin(srcMeta, eq(srcMeta.nodeId, claims.subjectNodeId))
    .leftJoin(tgtMeta, eq(tgtMeta.nodeId, claims.objectNodeId))
    .where(
      and(
        eq(claims.userId, userId),
        statusFilter,
        predicateFilter,
        or(eq(claims.subjectNodeId, nodeId), eq(claims.objectNodeId, nodeId)),
      ),
    );

  const sourceIdMap = await fetchSourceIdsForNodes(db, [nodeId]);
  const aliasMap = await listAliasesForNodeIds(db, userId, [nodeId]);

  return {
    node: {
      ...row,
      label: row.label ?? null,
      description: row.description ?? null,
      sourceIds: sourceIdMap.get(nodeId) ?? [],
      aliases: (aliasMap.get(nodeId) ?? []).map((alias) => ({
        id: alias.id,
        aliasText: alias.aliasText,
        createdAt: alias.createdAt,
      })),
    },
    claims: claimRows,
  };
}

/** Fetch raw source content linked to a node. */
export async function getNodeSources(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<GetNodeSourcesResponse> {
  const db = await useDatabase();

  // Verify node ownership
  const [nodeRow] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!nodeRow) return { sources: [] };

  // Get linked sources
  const linkedSources = await db
    .select({
      sourceId: sources.id,
      type: sources.type,
      metadata: sources.metadata,
      timestamp: sources.lastIngestedAt,
    })
    .from(sourceLinks)
    .innerJoin(sources, eq(sources.id, sourceLinks.sourceId))
    .where(eq(sourceLinks.nodeId, nodeId));

  if (linkedSources.length === 0) return { sources: [] };

  // Fetch raw content for each source
  const sourceIds = linkedSources.map((s) => s.sourceId as TypeId<"source">);
  const rawResults = await sourceService.fetchRaw(userId, sourceIds);
  const contentMap = new Map(
    rawResults.map((r) => [
      r.sourceId,
      r.kind === "inline" ? r.content : r.buffer.toString("utf-8"),
    ]),
  );

  return {
    sources: linkedSources.map((s) => ({
      sourceId: s.sourceId,
      type: s.type,
      content: contentMap.get(s.sourceId) ?? null,
      timestamp: s.timestamp,
    })),
  };
}

/** Update a node's label and/or nodeType. Re-generates embedding on label changes. */
export async function updateNode(
  userId: string,
  nodeId: TypeId<"node">,
  updates: { label?: string; nodeType?: NodeType },
): Promise<{
  id: TypeId<"node">;
  nodeType: string;
  label: string | null;
  description: string | null;
} | null> {
  const db = await useDatabase();

  // Verify ownership and fetch current state
  const [row] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      metaId: nodeMetadata.id,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!row) return null;

  if (updates.nodeType !== undefined) {
    await db
      .update(nodes)
      .set({ nodeType: updates.nodeType })
      .where(eq(nodes.id, nodeId));
  }

  const effectiveNodeType = updates.nodeType ?? row.nodeType;
  const newLabel = updates.label ?? row.label;

  if (updates.label !== undefined) {
    await db
      .update(nodeMetadata)
      .set({
        label: updates.label,
        canonicalLabel: normalizeLabel(updates.label),
      })
      .where(eq(nodeMetadata.id, row.metaId));
  }

  // Re-generate embedding if label changed
  if (newLabel && updates.label !== undefined) {
    const embText = `${newLabel}: ${row.description ?? ""}`;
    const embResponse = await generateEmbeddings({
      model: "jina-embeddings-v3",
      task: "retrieval.passage",
      input: [embText],
      truncate: true,
    });
    const embedding = embResponse.data[0]?.embedding;
    if (embedding) {
      // Delete old embedding and insert new one
      await db.delete(nodeEmbeddings).where(eq(nodeEmbeddings.nodeId, nodeId));
      await db.insert(nodeEmbeddings).values({
        nodeId,
        embedding,
        modelName: "jina-embeddings-v3",
      });
    }
  }

  return {
    id: row.id,
    nodeType: effectiveNodeType,
    label: newLabel ?? null,
    description: row.description ?? null,
  };
}

/**
 * Delete a node by ID. The Postgres FK graph handles every dependent row:
 *
 * - Claims where the node is the **subject** or **object** are removed via
 *   `ON DELETE CASCADE` on `claims.subject_node_id` / `claims.object_node_id`.
 *   Those claims are gone for good — their content (statement text, scalar
 *   `objectValue`, etc.) is not preserved.
 * - Claims that merely **attribute provenance** to this node (i.e.
 *   `claims.asserted_by_node_id` points at it) are kept; the column is set to
 *   `NULL` via `ON DELETE SET NULL`. Those claims remain `active` because the
 *   factual assertion outlives the participant pointer.
 * - `node_metadata`, `node_embeddings`, `aliases`, and `source_links` cascade
 *   away with the node.
 *
 * The caller receives counts of both effects so the deletion can be audited
 * (`affectedClaims.cascadeDeleted` and `affectedClaims.assertedByCleared`).
 *
 * NOTE: a claim's `statement` is human-readable narrative — it may textually
 * reference the deleted node by label (or even by id). That is content drift,
 * not a referential-integrity bug; the FK contract above governs structured
 * pointers only.
 */
export async function deleteNode(
  userId: string,
  nodeId: TypeId<"node">,
): Promise<{
  deleted: boolean;
  affectedClaims: { cascadeDeleted: number; assertedByCleared: number };
}> {
  const db = await useDatabase();

  return db.transaction(async (tx) => {
    // Count affected claims BEFORE the delete so we can report cascade vs
    // set-null effects accurately. Both queries are scoped to `userId` to
    // mirror the deletion's tenancy guard.
    const [cascadeRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(claims)
      .where(
        and(
          eq(claims.userId, userId),
          or(eq(claims.subjectNodeId, nodeId), eq(claims.objectNodeId, nodeId)),
        ),
      );

    const [assertedRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(claims)
      .where(
        and(eq(claims.userId, userId), eq(claims.assertedByNodeId, nodeId)),
      );

    const result = await tx
      .delete(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
      .returning({ id: nodes.id });

    const deleted = result.length > 0;
    return {
      deleted,
      affectedClaims: {
        cascadeDeleted: deleted ? (cascadeRow?.count ?? 0) : 0,
        assertedByCleared: deleted ? (assertedRow?.count ?? 0) : 0,
      },
    };
  });
}

/**
 * Bootstrap claim spec passed to {@link createNode}. The new node is the
 * subject; `objectNodeId` xor `objectValue` is required.
 */
export interface CreateNodeInitialClaimInput {
  predicate: Predicate;
  statement: string;
  description?: string | undefined;
  objectNodeId?: TypeId<"node"> | undefined;
  objectValue?: string | undefined;
  assertedByKind?: AssertedByKind | undefined;
  assertedByNodeId?: TypeId<"node"> | undefined;
}

/**
 * Create a new node with metadata and embedding, and attach it to the
 * Temporal day node for "today" via an `OCCURRED_ON` claim sourced from the
 * per-user manual system source. Day-node attachment preserves the
 * temporal-graph invariant that ingestion paths uphold (see
 * `ensureSourceNode`), so date-scoped queries like `nodeType` can find
 * manually-created nodes the same way they find ingested ones.
 *
 * `initialClaims` lets callers bootstrap the node with required claims
 * (e.g. a `Task` with its `HAS_TASK_STATUS` and `OWNED_BY`) so it is never
 * observable in a half-bootstrapped state. Claims are written sequentially
 * after the node is created; if any one fails, the node is deleted and the
 * original error is re-thrown.
 */
export async function createNode(
  userId: string,
  nodeType: NodeType,
  label: string,
  description?: string,
  initialClaims?: ReadonlyArray<CreateNodeInitialClaimInput>,
): Promise<{
  id: TypeId<"node">;
  nodeType: NodeType;
  label: string;
  description: string | null;
  initialClaimIds: TypeId<"claim">[];
}> {
  const db = await useDatabase();
  await ensureUser(db, userId);

  const [inserted] = await db
    .insert(nodes)
    .values({ userId, nodeType })
    .returning({ id: nodes.id });

  if (!inserted) throw new Error("Failed to create node");

  await db.insert(nodeMetadata).values({
    nodeId: inserted.id,
    label,
    canonicalLabel: normalizeLabel(label),
    description: description ?? null,
  });

  // Routes embedding through the shared helper so the harness's
  // `setSkipEmbeddingPersistence` seam short-circuits the Jina call (mirrors
  // every other ingestion path; previously this site bypassed it).
  await generateAndInsertNodeEmbeddings(db, [
    { id: inserted.id, label, description: description ?? null },
  ]);

  const sourceId = await ensureSystemSource(db, userId, "manual");
  await db
    .insert(sourceLinks)
    .values({ sourceId, nodeId: inserted.id })
    .onConflictDoNothing();

  // Link to today's day node via OCCURRED_ON, mirroring `ensureSourceNode`.
  // Skip for Temporal nodes themselves to avoid a self-link / cycle.
  if (nodeType !== "Temporal") {
    const now = new Date();
    const dayNodeId = await ensureDayNode(db, userId, now);
    await db.insert(claims).values({
      userId,
      predicate: "OCCURRED_ON",
      subjectNodeId: inserted.id,
      objectNodeId: dayNodeId,
      statement: `${nodeType} node occurred on ${format(now, "yyyy-MM-dd")}`,
      sourceId,
      scope: "personal",
      assertedByKind: "system",
      statedAt: now,
      status: "active",
    });
  }

  const initialClaimIds: TypeId<"claim">[] = [];
  if (initialClaims && initialClaims.length > 0) {
    try {
      for (const claim of initialClaims) {
        const created = await createClaim({
          userId,
          subjectNodeId: inserted.id,
          predicate: claim.predicate,
          statement: claim.statement,
          description: claim.description,
          objectNodeId: claim.objectNodeId,
          objectValue: claim.objectValue,
          assertedByKind: claim.assertedByKind,
          assertedByNodeId: claim.assertedByNodeId,
        });
        initialClaimIds.push(created.id);
      }
    } catch (err) {
      // Roll back the node so callers don't see a half-bootstrapped record.
      // FK ON DELETE CASCADE removes already-created claims and metadata.
      await db
        .delete(nodes)
        .where(and(eq(nodes.id, inserted.id), eq(nodes.userId, userId)));
      throw err;
    }
  }

  return {
    id: inserted.id,
    nodeType,
    label,
    description: description ?? null,
    initialClaimIds,
  };
}

/** Merge multiple nodes into one. First node is the survivor. */
export async function mergeNodes(
  userId: string,
  nodeIds: TypeId<"node">[],
  overrides?: { targetLabel?: string; targetDescription?: string },
): Promise<{
  id: TypeId<"node">;
  nodeType: string;
  label: string;
  description: string | null;
} | null> {
  const db = await useDatabase();

  const foundNodes = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
      additionalData: nodeMetadata.additionalData,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)));

  if (foundNodes.length !== nodeIds.length) return null;

  // Refuse cross-scope merges. Same rule as dedup-sweep.
  const scopeMap = await getEffectiveNodeScopes(db, userId, nodeIds);
  const scopes = nodeIds.map((id) => scopeMap.get(id) ?? "personal");
  const distinctScopes = new Set(scopes);
  if (distinctScopes.size > 1) {
    throw new CrossScopeMergeError(nodeIds, [...distinctScopes]);
  }

  const survivorId = nodeIds[0]!;
  const consumedIds = nodeIds.slice(1);
  const survivorRow = foundNodes.find((n) => n.id === survivorId)!;

  const finalLabel = overrides?.targetLabel ?? survivorRow.label ?? "";
  const finalDescription =
    overrides?.targetDescription !== undefined
      ? overrides.targetDescription
      : survivorRow.description;

  // If the survivor carries `unresolvedSpeaker = true` but at least one of the
  // consumed nodes did not, the merged identity is now resolved — strip the
  // flag from the survivor's metadata after the merge.
  const survivorIsPlaceholder = readUnresolvedSpeakerFlag(
    survivorRow.additionalData,
  );
  const anyConsumedResolved = consumedIds.some((id) => {
    const row = foundNodes.find((n) => n.id === id);
    return row !== undefined && !readUnresolvedSpeakerFlag(row.additionalData);
  });
  const shouldClearUnresolvedSpeaker =
    survivorIsPlaceholder && anyConsumedResolved;

  await db.transaction(async (tx) => {
    for (const consumedId of consumedIds) {
      await tx
        .update(claims)
        .set({ subjectNodeId: survivorId, updatedAt: new Date() })
        .where(
          and(eq(claims.userId, userId), eq(claims.subjectNodeId, consumedId)),
        );

      await tx
        .update(claims)
        .set({ objectNodeId: survivorId, updatedAt: new Date() })
        .where(
          and(eq(claims.userId, userId), eq(claims.objectNodeId, consumedId)),
        );

      // Rewire participant provenance pointers BEFORE the consumed node is
      // deleted; otherwise the FK's ON DELETE SET NULL would silently drop
      // attribution.
      await tx
        .update(claims)
        .set({ assertedByNodeId: survivorId, updatedAt: new Date() })
        .where(
          and(
            eq(claims.userId, userId),
            eq(claims.assertedByNodeId, consumedId),
          ),
        );

      await tx.execute(sql`
        DELETE FROM claims
        WHERE user_id = ${userId}
          AND subject_node_id = ${survivorId}
          AND object_node_id = ${survivorId}
      `);

      await tx.execute(sql`
        DELETE FROM claims c
        USING claims kept
        WHERE c.user_id = ${userId}
          AND kept.user_id = c.user_id
          AND kept.id <> c.id
          AND kept.subject_node_id = c.subject_node_id
          AND kept.predicate = c.predicate
          AND kept.source_id = c.source_id
          AND kept.object_node_id IS NOT DISTINCT FROM c.object_node_id
          AND kept.object_value IS NOT DISTINCT FROM c.object_value
          AND kept.asserted_by_kind = c.asserted_by_kind
          AND kept.asserted_by_node_id IS NOT DISTINCT FROM c.asserted_by_node_id
          AND (kept.created_at, kept.id) < (c.created_at, c.id)
      `);

      // Consolidate source_links
      await tx.execute(sql`
        UPDATE source_links
        SET node_id = ${survivorId}
        WHERE node_id = ${consumedId}
          AND NOT EXISTS (
            SELECT 1 FROM source_links sl2
            WHERE sl2.node_id = ${survivorId}
              AND sl2.source_id = source_links.source_id
          )
      `);

      await tx.delete(sourceLinks).where(eq(sourceLinks.nodeId, consumedId));
    }

    // Delete consumed nodes
    await tx
      .delete(nodes)
      .where(and(eq(nodes.userId, userId), inArray(nodes.id, consumedIds)));

    // Update survivor metadata
    await tx
      .update(nodeMetadata)
      .set({
        label: finalLabel,
        canonicalLabel: normalizeLabel(finalLabel),
        description: finalDescription,
      })
      .where(eq(nodeMetadata.nodeId, survivorId));

    // If the survivor was a placeholder but a resolved Person was merged into
    // it, the placeholder marker is no longer accurate. Strip it via JSONB
    // minus so the rest of `additionalData` is preserved.
    if (shouldClearUnresolvedSpeaker) {
      await tx.execute(sql`
        UPDATE node_metadata
        SET additional_data = additional_data - 'unresolvedSpeaker'
        WHERE node_id = ${survivorId}
      `);
    }

    // Delete self-referencing relationship claims
    await tx.execute(sql`
      DELETE FROM claims
      WHERE user_id = ${userId}
        AND subject_node_id = ${survivorId}
        AND object_node_id = ${survivorId}
    `);
  });

  // Re-generate embedding (outside transaction — external API call)
  const embText = `${finalLabel}: ${finalDescription ?? ""}`;
  const embResponse = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [embText],
    truncate: true,
  });
  const embedding = embResponse.data[0]?.embedding;
  if (embedding) {
    await db
      .delete(nodeEmbeddings)
      .where(eq(nodeEmbeddings.nodeId, survivorId));
    await db.insert(nodeEmbeddings).values({
      nodeId: survivorId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }

  return {
    id: survivorId,
    nodeType: survivorRow.nodeType,
    label: finalLabel,
    description: finalDescription ?? null,
  };
}

/** Batch delete nodes in a single query. */
export async function batchDeleteNodes(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<number> {
  const db = await useDatabase();
  const result = await db
    .delete(nodes)
    .where(and(eq(nodes.userId, userId), inArray(nodes.id, nodeIds)))
    .returning({ id: nodes.id });
  return result.length;
}

/** Get ego-graph neighborhood around a focal node. */
export async function getNodeNeighborhood(
  userId: string,
  nodeId: TypeId<"node">,
  depth: 1 | 2 = 1,
): Promise<{
  nodes: {
    id: TypeId<"node">;
    nodeType: string;
    label: string;
    description: string | null;
    sourceIds: string[];
  }[];
  claims: {
    id: TypeId<"claim">;
    subject: TypeId<"node">;
    object: TypeId<"node"> | null;
    predicate: string;
    statement: string;
    description: string | null;
    sourceId: TypeId<"source">;
    statedAt: Date;
    status: string;
  }[];
} | null> {
  const db = await useDatabase();

  const [focal] = await db
    .select({
      id: nodes.id,
      nodeType: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)))
    .limit(1);

  if (!focal) return null;

  const allNodeIds = new Set<TypeId<"node">>([nodeId]);
  const nodeMap = new Map<
    TypeId<"node">,
    {
      id: TypeId<"node">;
      nodeType: string;
      label: string;
      description: string | null;
    }
  >();
  nodeMap.set(nodeId, {
    id: focal.id,
    nodeType: focal.nodeType,
    label: focal.label ?? "",
    description: focal.description,
  });

  const hop1 = await findOneHopNodes(db, userId, [nodeId]);
  for (const n of hop1) {
    if (!allNodeIds.has(n.id)) {
      allNodeIds.add(n.id);
      nodeMap.set(n.id, {
        id: n.id,
        nodeType: n.type,
        label: n.label ?? "",
        description: n.description,
      });
    }
  }

  if (depth === 2) {
    const hop1Ids = hop1.map((n) => n.id).filter((id) => id !== nodeId);
    if (hop1Ids.length > 0) {
      const hop2 = await findOneHopNodes(db, userId, hop1Ids);
      for (const n of hop2) {
        if (!allNodeIds.has(n.id)) {
          allNodeIds.add(n.id);
          nodeMap.set(n.id, {
            id: n.id,
            nodeType: n.type,
            label: n.label ?? "",
            description: n.description,
          });
        }
      }
    }
  }

  const ids = Array.from(allNodeIds);
  const [claimRows, sourceIdMap] = await Promise.all([
    fetchClaimsBetweenNodeIds(db, userId, ids),
    fetchSourceIdsForNodes(db, ids),
  ]);

  return {
    nodes: Array.from(nodeMap.values()).map((n) => ({
      ...n,
      sourceIds: sourceIdMap.get(n.id) ?? [],
    })),
    claims: claimRows,
  };
}
