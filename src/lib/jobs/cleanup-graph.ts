/**
 * Subgraph-driven LLM cleanup pipeline.
 *
 * Builds a focused subgraph from seed nodes, asks an LLM to propose
 * cleanup operations from the vocabulary in `cleanup-operations.ts`, and
 * applies them via `applyCleanupOperations`. Provenance (`assertedByKind`,
 * `scope`) and real claim ids are surfaced to the model so it can use the
 * `retract_claim`, `contradict_claim`, and `promote_assertion` operations.
 *
 * Common aliases: cleanup-graph, proposeGraphCleanup, buildCleanupPrompt,
 * cleanup pipeline, cleanup prompt builder.
 */
import { createCompletionClient } from "../ai";
import { getConversationBootstrapContext } from "../context/assemble-bootstrap-context";
import type { ContextBundle } from "../context/types";
import { generateAndInsertNodeEmbeddings } from "../embeddings-util";
import { findOneHopNodes, findSimilarNodes } from "../graph";
import { TemporaryIdMapper } from "../temporary-id-mapper";
import {
  applyCleanupOperations,
  CleanupOperationsSchema,
  type CleanupOperations,
} from "./cleanup-operations";
import { sql, eq, gte, desc, and, inArray } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import {
  nodes,
  claims,
  nodeMetadata,
  nodeEmbeddings,
  sourceLinks,
} from "~/db/schema";
import type {
  AssertedByKind,
  NodeType,
  RelationshipPredicate,
  Scope,
} from "~/types/graph";
import { TypeId, typeIdSchema } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export const CleanupGraphJobInputSchema = z.object({
  userId: z.string(),
  since: z.coerce.date(),
  entryNodeLimit: z.number().int().positive().default(5),
  semanticNeighborLimit: z.number().int().positive().default(15),
  graphHopDepth: z.union([z.literal(1), z.literal(2)]).default(2),
  maxSubgraphNodes: z.number().int().positive().default(100),
  maxSubgraphClaims: z.number().int().positive().default(150),
  llmModelId: z.string(),
  seedIds: z
    .array(typeIdSchema("node"))
    .optional()
    .describe("Optional manual seed node IDs"),
});

/**
 * Parameters for cleanup job
 */
export type CleanupGraphParams = z.infer<typeof CleanupGraphJobInputSchema>;

/**
 * Core graph types
 */
export interface GraphNode {
  id: TypeId<"node">;
  label: string;
  description: string;
  type: NodeType;
}

/**
 * Core graph types — relationship-shaped claims surfaced to the cleanup LLM.
 * Carries provenance so the model can see which claims are
 * `assistant_inferred` vs user-attributed and decide between
 * `retract_claim` / `promote_assertion` / no-op.
 */
export interface GraphClaim {
  id: TypeId<"claim">;
  subject: TypeId<"node">;
  object: TypeId<"node">;
  predicate: RelationshipPredicate;
  statement: string;
  scope: Scope;
  assertedByKind: AssertedByKind;
}
export interface Subgraph {
  nodes: GraphNode[];
  claims: GraphClaim[];
}

/**
 * Temporary graph for LLM
 */
export interface TempNode extends GraphNode {
  tempId: string;
}
export interface TempClaim {
  id: TypeId<"claim">;
  subjectTemp: string;
  objectTemp: string;
  predicate: RelationshipPredicate;
  statement: string;
  scope: Scope;
  assertedByKind: AssertedByKind;
}
export interface TempSubgraph {
  nodes: TempNode[];
  claims: TempClaim[];
}

/**
 * Detailed result of cleanup execution. Reported as best-effort counts so
 * the iterative loop can decide whether to harvest more seeds.
 */
export interface CleanupGraphResult {
  applied: number;
  skipped: number;
  errors: Array<{ kind: string; message: string }>;
  /** Real node ids touched by the applied operations. */
  affectedNodeIds: TypeId<"node">[];
}

/**
 * Params for one cleanup iteration with explicit seeds
 */
export interface CleanupGraphIterationParams extends CleanupGraphParams {
  seedIds: TypeId<"node">[];
  /** Minimum nodes required in subgraph to proceed (default 5) */
  minSubgraphNodes?: number;
}

/**
 * Core single-iteration cleanup: builds subgraph from seedIds, asks the LLM
 * for a list of operations, and applies them via the new dispatcher.
 */
export async function cleanupGraphIteration(
  params: CleanupGraphIterationParams,
): Promise<CleanupGraphResult | null> {
  const {
    userId,
    seedIds,
    semanticNeighborLimit,
    graphHopDepth,
    maxSubgraphNodes,
    maxSubgraphClaims,
    llmModelId,
    minSubgraphNodes = 5,
  } = params;
  // 1. build subgraph from provided seeds
  const sub = await buildSubgraph(
    userId,
    seedIds,
    semanticNeighborLimit,
    graphHopDepth,
    maxSubgraphNodes,
    maxSubgraphClaims,
  );
  if (sub.nodes.length < minSubgraphNodes) {
    console.debug(
      `[cleanup-iter] Subgraph too small (${sub.nodes.length} < ${minSubgraphNodes}); skipping iteration`,
    );
    return null;
  }
  // 2. map to temporary IDs
  const { tempSubgraph, mapper } = toTempSubgraph(sub);
  // 3. propose cleanup via LLM (operation vocabulary)
  const { operations } = await proposeGraphCleanup(
    userId,
    tempSubgraph,
    llmModelId,
  );
  // 4. apply operations to DB. The allowed-claim-id set bounds the dispatcher
  // to claims actually rendered into the prompt; the LLM cannot reference
  // out-of-subgraph claim ids it hallucinated or recalled from earlier turns.
  const db = await useDatabase();
  const allowedClaimIds = new Set<TypeId<"claim">>(sub.claims.map((c) => c.id));
  const applyResult = await applyCleanupOperations(
    db,
    userId,
    operations,
    mapper,
    allowedClaimIds,
  );
  const result: CleanupGraphResult = {
    applied: applyResult.applied,
    skipped: applyResult.skipped,
    errors: applyResult.errors,
    affectedNodeIds: applyResult.affectedNodeIds,
  };
  // 5. log summary and return
  logCleanupSummary(params, result, operations.length);
  return result;
}

/**
 * Step 1: select entry nodes
 */
export async function fetchEntryNodes(
  userId: string,
  since: Date,
  limit: number,
): Promise<TypeId<"node">[]> {
  // Select nodes with highest edge count since given date
  const db = await useDatabase();
  const rows = await db
    .select({
      nodeId: claims.subjectNodeId,
      count: sql<number>`COUNT(*)`.as("count"),
    })
    .from(claims)
    .where(and(eq(claims.userId, userId), gte(claims.createdAt, since)))
    .groupBy(claims.subjectNodeId)
    .orderBy(desc(sql`count`))
    .limit(limit);
  return rows.map((r) => r.nodeId);
}

/**
 * Step 2: expand to a subgraph
 */
async function buildSubgraph(
  userId: string,
  seedIds: TypeId<"node">[],
  semanticLimit: number,
  hopDepth: number,
  maxNodes: number,
  maxClaims: number,
): Promise<Subgraph> {
  const db = await useDatabase();
  // load seed metadata
  const seedMetaRows = await db
    .select({
      id: nodes.id,
      type: nodes.nodeType,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(inArray(nodes.id, seedIds));
  // store nodes in insertion order
  const nodeMap = new Map<TypeId<"node">, GraphNode>();
  for (const r of seedMetaRows) {
    nodeMap.set(r.id, {
      id: r.id,
      label: r.label ?? "",
      description: r.description ?? "",
      type: r.type,
    });
  }
  // semantic neighbors (run in parallel)
  const seeds = Array.from(nodeMap.values());
  const neighborResults = await Promise.all(
    seeds.map((seed) =>
      findSimilarNodes({
        userId,
        text: `${seed.label}: ${seed.description}`,
        limit: semanticLimit,
        minimumSimilarity: 0.5,
      }),
    ),
  );
  for (const neighbors of neighborResults) {
    for (const n of neighbors) {
      if (!nodeMap.has(n.id)) {
        nodeMap.set(n.id, {
          id: n.id,
          label: n.label ?? "",
          description: n.description ?? "",
          type: n.type,
        });
      }
    }
  }
  const claimsList: GraphClaim[] = [];
  // Expand connections
  let currentIds = Array.from(nodeMap.keys());
  for (let hop = 1; hop <= hopDepth; hop++) {
    const conns = await findOneHopNodes(db, userId, currentIds);
    const nextIds: typeof currentIds = [];
    for (const c of conns) {
      if (!nodeMap.has(c.id)) {
        nodeMap.set(c.id, {
          id: c.id,
          label: c.label ?? "",
          description: c.description ?? "",
          type: c.type,
        });
        nextIds.push(c.id);
      }
      claimsList.push({
        id: c.claimId,
        subject: c.claimSubjectId,
        object: c.claimObjectId,
        predicate: c.predicate as RelationshipPredicate,
        statement: c.statement,
        scope: c.scope,
        assertedByKind: c.assertedByKind,
      });
    }
    currentIds = nextIds;
    if (!currentIds.length) break;
  }
  // dedupe claims by id
  const unique: GraphClaim[] = [];
  const seen = new Set<string>();
  for (const claim of claimsList) {
    if (!seen.has(claim.id)) {
      seen.add(claim.id);
      unique.push(claim);
    }
  }
  // trim nodes & claims, ensuring claims only reference kept nodes
  const nodesArr = Array.from(nodeMap.values()).slice(0, maxNodes);
  const nodeIdsSet = new Set(nodesArr.map((n) => n.id));
  const claimsArr = unique
    .filter(
      (claim) => nodeIdsSet.has(claim.subject) && nodeIdsSet.has(claim.object),
    )
    .slice(0, maxClaims);
  return { nodes: nodesArr, claims: claimsArr };
}

/**
 * Step 3: map to temporary IDs for LLM
 */
function toTempSubgraph(sub: Subgraph): {
  tempSubgraph: TempSubgraph;
  mapper: TemporaryIdMapper<GraphNode, string>;
} {
  const mapper = new TemporaryIdMapper<GraphNode, string>(
    (_item, idx) => `temp_node_${idx + 1}`,
  );
  const tempNodes = mapper.mapItems(sub.nodes);
  const tempClaims: TempClaim[] = sub.claims.map((claim) => {
    const src = sub.nodes.find((n) => n.id === claim.subject)!;
    const tgt = sub.nodes.find((n) => n.id === claim.object)!;
    return {
      id: claim.id,
      subjectTemp: mapper.getId(src)!,
      objectTemp: mapper.getId(tgt)!,
      predicate: claim.predicate,
      statement: claim.statement,
      scope: claim.scope,
      assertedByKind: claim.assertedByKind,
    };
  });
  return { tempSubgraph: { nodes: tempNodes, claims: tempClaims }, mapper };
}

/**
 * Render a `ContextBundle` as labeled prompt blocks. Each section becomes
 * a `<section kind="…">` tag with its content; the section's `usage` hint
 * is included as a leading comment line so the model knows how the host
 * intends the section to be used. Empty bundles render as the empty
 * string (the assembler already drops empty sections).
 */
function renderBundleSections(bundle: ContextBundle): string {
  if (bundle.sections.length === 0) return "";
  return bundle.sections
    .map(
      (section) =>
        `<section kind="${section.kind}">\n<!-- ${section.usage} -->\n${section.content}\n</section>`,
    )
    .join("\n\n");
}

/**
 * Build the cleanup prompt from a temp subgraph + bootstrap context bundle.
 *
 * Pure function — no DB / network. Extracted so the rendered string can be
 * tested directly and the prompt can evolve without touching the LLM call
 * site.
 */
export function buildCleanupPrompt(
  temp: TempSubgraph,
  bundle: ContextBundle,
): string {
  const nodesList = temp.nodes
    .map(
      (n) =>
        `<node tempId="${n.tempId}" label="${n.label}" type="${n.type}">${n.description}</node>`,
    )
    .join("\n");
  const claimsList = temp.claims
    .map(
      (claim) =>
        `<claim id="${claim.id}" subject="${claim.subjectTemp}" object="${claim.objectTemp}" predicate="${claim.predicate}" provenance="[${claim.assertedByKind}, ${claim.scope}]">${claim.statement}</claim>`,
    )
    .join("\n");
  const bundleText = renderBundleSections(bundle);

  return `You are a graph cleaning assistant. Your task is to analyze this claim subgraph and propose cleanup operations to ensure accuracy, remove redundancies, and reconcile contradictions.

Output a single JSON object \`{ "operations": [...] }\` matching the cleanup operation vocabulary:

- \`merge_nodes { keepTempId, removeTempIds }\` — collapse duplicates / aliases. Prefer this over \`delete_node\` whenever two nodes plausibly represent the same entity.
- \`delete_node { tempId }\` — only for orphan nodes with no claims, source links, or aliases. Prefer \`merge_nodes\` for duplicates and claim-level operations for bad facts.
- \`retract_claim { claimId, reason }\` — ONLY for \`assistant_inferred\` claims that lack corroboration in the bundle / subgraph. Never use this for \`user\`, \`user_confirmed\`, \`participant\`, \`document_author\`, or \`system\` claims.
- \`contradict_claim { claimId, contradictedByClaimId, reason }\` — citation REQUIRED. Use only when another ACTIVE, same-scope, source-backed claim already in this subgraph contradicts the original. Pass the citing claim's real id in \`contradictedByClaimId\`. Do not cite \`assistant_inferred\` or \`system\` claims.
- \`promote_assertion { claimId, corroboratingSourceId, reason }\` — when an \`assistant_inferred\` claim is corroborated by a user-attributed source visible in the bundle (i.e., bundle evidence cites a claim with the same fact, attributed to \`user\` or \`user_confirmed\`). The corroborating source id is the \`sourceId\` field on that bundle evidence row.
- \`add_claim { subjectTempId, objectTempId? | objectValue?, predicate, statement, sourceClaimId? }\` — system-authored. Use SPARINGLY and only for facts directly inferrable from the subgraph (e.g., a transitive relation visible in two existing claims). When at all possible, cite \`sourceClaimId\` from the subgraph (the real \`clm_*\` id) so scope is inherited correctly. Never invent facts not grounded in the subgraph.
- \`add_alias { nodeTempId, aliasText }\` / \`remove_alias { nodeTempId, aliasText }\` — alias hygiene.
- \`create_node { tempId, label, description, type }\` — only if a referenced entity is genuinely missing.

ID rules:
- Operations that touch nodes (\`merge_nodes\`, \`delete_node\`, \`add_claim\`, \`add_alias\`, \`remove_alias\`, \`create_node\`) reference temp ids: the \`tempId\` of an existing subgraph node (\`temp_node_*\`) or the \`tempId\` you declared on a prior \`create_node\`.
- Operations that touch claims (\`retract_claim\`, \`contradict_claim\`, \`promote_assertion\`) reference REAL claim ids — the \`id="clm_..."\` attribute on each \`<claim>\` line below.

Cleaning rules:
1. **The bundle is not the full memory.** It is high-signal current context, not a complete evidence set. Absence from the bundle is NEVER sufficient reason to retract or contradict a sourced claim.
2. **Reconcile against explicit contradictions.** Claims that directly contradict a specific claim visible in this subgraph should be \`contradict_claim\` with that cited claim id. Atlas / open_commitments / preferences guide cleanup, but they are not standalone citations.
3. **Provenance gates retraction.** A claim with \`provenance=[assistant_inferred, …]\` and no corroboration in the bundle or in adjacent claims is the only valid \`retract_claim\` target. Do NOT retract claims with \`provenance=[user, …]\`, \`[user_confirmed, …]\`, \`[participant, …]\`, \`[document_author, …]\`, or \`[system, …]\`.
4. **Promote, don't duplicate.** When the bundle's evidence shows a \`user\`/\`user_confirmed\` claim that says the same thing as an \`assistant_inferred\` subgraph claim, emit \`promote_assertion\` rather than \`add_claim\`.
5. **Prefer \`merge_nodes\` over \`delete_node\`.** If two nodes plausibly refer to the same entity (similar labels, overlapping aliases, compatible types), merge.
6. **No fabricated facts.** Never \`add_claim\` something that isn't already inferrable from the subgraph + bundle. System-authored claims must cite a \`sourceClaimId\` whenever possible.
7. **Idempotence.** Don't add a claim that duplicates an existing relationship visible in the subgraph.

${bundleText ? `<bundle>\n${bundleText}\n</bundle>\n\n` : ""}<subgraph>
<nodes>
${nodesList}
</nodes>
<claims>
${claimsList}
</claims>
</subgraph>
`;
}

/**
 * Step 4: get cleanup operations from LLM. Returns a parsed
 * `CleanupOperations` payload (`{ operations: [...] }`).
 */
export async function proposeGraphCleanup(
  userId: string,
  temp: TempSubgraph,
  modelId: string,
): Promise<CleanupOperations> {
  const client = await createCompletionClient(userId);

  // Bundle is the structured equivalent of the legacy "user atlas" string —
  // five sections (pinned, atlas, open_commitments, recent_supersessions,
  // preferences) with usage hints + evidence refs.
  const bundle = await getConversationBootstrapContext({ userId });

  const prompt = buildCleanupPrompt(temp, bundle);

  const completion = await client.beta.chat.completions.parse({
    messages: [{ role: "user", content: prompt }],
    model: modelId,
    response_format: zodResponseFormat(
      CleanupOperationsSchema,
      "CleanupOperations",
    ),
  });
  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("Failed to parse cleanup operations");
  return parsed;
}

/**
 * Rewire claims from removeId to keepId for a given user. Still exported
 * because the dedup-sweep job uses it directly (separate code path from
 * the operation dispatcher).
 */
export async function rewireNodeClaims(
  tx: DrizzleDB,
  removeId: TypeId<"node">,
  keepId: TypeId<"node">,
  userId: string,
) {
  await tx
    .update(claims)
    .set({ subjectNodeId: keepId, updatedAt: new Date() })
    .where(and(eq(claims.subjectNodeId, removeId), eq(claims.userId, userId)));

  await tx
    .update(claims)
    .set({ objectNodeId: keepId, updatedAt: new Date() })
    .where(and(eq(claims.objectNodeId, removeId), eq(claims.userId, userId)));

  // Rewire participant provenance BEFORE deletion. The FK uses ON DELETE SET
  // NULL, so without this update historical participant claims would silently
  // lose attribution when the consumed node is removed.
  await tx
    .update(claims)
    .set({ assertedByNodeId: keepId, updatedAt: new Date() })
    .where(
      and(eq(claims.assertedByNodeId, removeId), eq(claims.userId, userId)),
    );

  await tx.execute(sql`
    DELETE FROM claims
    WHERE user_id = ${userId}
      AND subject_node_id = ${keepId}
      AND object_node_id = ${keepId}
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
}

/**
 * Rewire source_links entries from removeId to keepId. Used by the dedup
 * sweep; the operation dispatcher delegates to {@link mergeNodes} which
 * handles its own source_links consolidation.
 */
export async function rewireSourceLinks(
  tx: DrizzleDB,
  removeId: TypeId<"node">,
  keepId: TypeId<"node">,
) {
  const links = await tx
    .select()
    .from(sourceLinks)
    .where(eq(sourceLinks.nodeId, removeId));
  for (const link of links) {
    await tx
      .insert(sourceLinks)
      .values({ ...link, id: undefined, nodeId: keepId })
      .onConflictDoNothing({
        target: [sourceLinks.sourceId, sourceLinks.nodeId],
      });
  }
  await tx.delete(sourceLinks).where(eq(sourceLinks.nodeId, removeId));
}

/**
 * Delete a node for a given user; cascades remove related data. Used by
 * the dedup-sweep code path.
 */
export async function deleteNode(
  tx: DrizzleDB,
  nodeId: TypeId<"node">,
  userId: string,
) {
  await tx
    .delete(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.userId, userId)));
}

/**
 * Step 6: logging summary
 */
function logCleanupSummary(
  params: CleanupGraphParams,
  result: CleanupGraphResult,
  operationCount: number,
): void {
  console.info(
    `[CLEANUP] user=${params.userId} seeds=${params.entryNodeLimit} hops=${params.graphHopDepth} ` +
      `ops=${operationCount} applied=${result.applied} skipped=${result.skipped} errors=${result.errors.length}`,
  );
}

/**
 * Truncates all node labels longer than 255 characters for a specific user.
 * This is a simple cleanup operation to prevent excessively long labels from causing issues.
 */
export async function truncateLongLabels(
  userId: string,
): Promise<{ updatedCount: number }> {
  const db = await useDatabase();

  // Find all nodeMetadata records with labels longer than 255 characters for this user
  const longLabelNodes = await db
    .select({
      id: nodeMetadata.id,
      nodeId: nodeMetadata.nodeId,
      label: nodeMetadata.label,
    })
    .from(nodeMetadata)
    .innerJoin(nodes, eq(nodes.id, nodeMetadata.nodeId))
    .where(
      and(
        eq(nodes.userId, userId),
        sql`${nodeMetadata.label} IS NOT NULL`,
        sql`length(${nodeMetadata.label}) > 255`,
      ),
    );

  if (longLabelNodes.length === 0) {
    return { updatedCount: 0 };
  }

  console.log(
    `Found ${longLabelNodes.length} nodes with labels longer than 255 characters`,
  );

  // Update each node's label to be truncated to 255 characters
  let updatedCount = 0;
  for (const node of longLabelNodes) {
    if (node.label) {
      const truncatedLabel = node.label.substring(0, 255);
      await db
        .update(nodeMetadata)
        .set({ label: truncatedLabel })
        .where(eq(nodeMetadata.id, node.id));
      updatedCount++;

      console.log(
        `Truncated label for node ${node.nodeId}: "${node.label.substring(0, 50)}..." -> "${truncatedLabel.substring(0, 50)}..."`,
      );
    }
  }

  console.log(`Successfully truncated ${updatedCount} node labels`);
  return { updatedCount };
}

/**
 * Generates embeddings for nodes that have labels but are missing embeddings.
 * This is a cleanup operation to ensure all nodes with content have searchable embeddings.
 */
export async function generateMissingNodeEmbeddings(
  userId: string,
): Promise<{ generatedCount: number }> {
  const db = await useDatabase();

  // Find nodes that have labels but no embeddings for this user
  const nodesWithoutEmbeddings = await db
    .select({
      id: nodes.id,
      label: nodeMetadata.label,
      description: nodeMetadata.description,
    })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .leftJoin(nodeEmbeddings, eq(nodeEmbeddings.nodeId, nodes.id))
    .where(
      and(
        eq(nodes.userId, userId),
        sql`${nodeMetadata.label} IS NOT NULL`,
        sql`trim(${nodeMetadata.label}) != ''`,
        sql`${nodeEmbeddings.nodeId} IS NULL`,
      ),
    );

  if (nodesWithoutEmbeddings.length === 0) {
    console.log("No nodes found with labels but missing embeddings");
    return { generatedCount: 0 };
  }

  console.log(
    `Found ${nodesWithoutEmbeddings.length} nodes with labels but missing embeddings`,
  );

  // Use the existing central embedding generation function
  await generateAndInsertNodeEmbeddings(
    db,
    nodesWithoutEmbeddings.map((node) => ({
      id: node.id,
      label: node.label!,
      description: node.description,
    })),
  );

  console.log(
    `Successfully generated embeddings for ${nodesWithoutEmbeddings.length} nodes`,
  );
  return { generatedCount: nodesWithoutEmbeddings.length };
}
