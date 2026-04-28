import { createAlias, normalizeAliasText } from "./alias";
import { applyClaimLifecycle, fetchClaimsByIds } from "./claims/lifecycle";
import { debugGraph } from "./debug-utils";
import {
  generateAndInsertNodeEmbeddings,
  generateAndInsertClaimEmbeddings,
} from "./embeddings-util";
import { formatNodesForPrompt } from "./formatting";
import { findSimilarNodes, findOneHopNodes, findNodesByType } from "./graph";
import { normalizeLabel } from "./label";
import { getOpenCommitments } from "./query/open-commitments";
import { type OpenCommitment } from "./schemas/open-commitments";
import { safeToISOString } from "./safe-date";
import { TemporaryIdMapper } from "./temporary-id-mapper";
import { and, eq, inArray } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import { type DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, sourceLinks, sources } from "~/db/schema";
import {
  AssertedByKind,
  AssertedByKindEnum,
  AttributePredicateEnum,
  NodeTypeEnum,
  RelationshipPredicateEnum,
  Scope,
  SourceType,
} from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";
import { env } from "~/utils/env";

const llmNodeSchema = z.object({
  id: z.string().describe("id to reference in claims"),
  type: NodeTypeEnum.describe("one of the allowed node types"),
  label: z.string().describe("human-readable name/title"),
  description: z.string().describe("longer text description").optional(),
});
type LlmOutputNode = z.infer<typeof llmNodeSchema>;

const llmRelationshipClaimSchema = z.object({
  subjectId: z.string().describe("id of the subject node"),
  objectId: z.string().describe("id of the object node"),
  predicate: RelationshipPredicateEnum.describe(
    "one of the allowed predicates",
  ),
  statement: z.string().describe("short sentence stating the sourced claim"),
  sourceRef: z
    .string()
    .min(1)
    .describe("source reference that supports the claim"),
  assertionKind: AssertedByKindEnum.describe(
    "who asserted this claim (see CRITICAL EXTRACTION RULES)",
  ),
  // Accepted but ignored in this phase — no speaker map yet, so participant
  // claims are rejected downstream until transcript ingestion lands.
  assertedBySpeakerLabel: z.string().optional(),
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});
type LlmOutputRelationshipClaim = z.infer<typeof llmRelationshipClaimSchema>;

const llmAttributeClaimSchema = z.object({
  subjectId: z.string().describe("id of the subject node"),
  predicate: AttributePredicateEnum.describe("one of the allowed predicates"),
  objectValue: z.string().describe("scalar value for the attribute claim"),
  statement: z.string().describe("short sentence stating the sourced claim"),
  sourceRef: z
    .string()
    .min(1)
    .describe("source reference that supports the claim"),
  assertionKind: AssertedByKindEnum.describe(
    "who asserted this claim (see CRITICAL EXTRACTION RULES)",
  ),
  // Accepted but ignored in this phase — no speaker map yet, so participant
  // claims are rejected downstream until transcript ingestion lands.
  assertedBySpeakerLabel: z.string().optional(),
  statedAt: z.string().datetime().optional(),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});
type LlmOutputAttributeClaim = z.infer<typeof llmAttributeClaimSchema>;

const llmAliasSchema = z.object({
  subjectId: z.string().describe("id of the node being aliased"),
  aliasText: z
    .string()
    .min(1)
    .describe("alternate name or spelling for the node"),
});
type LlmOutputAlias = z.infer<typeof llmAliasSchema>;

const llmExtractionSchema = z.object({
  nodes: z.array(llmNodeSchema),
  relationshipClaims: z.array(llmRelationshipClaimSchema),
  attributeClaims: z.array(llmAttributeClaimSchema),
  aliases: z.array(llmAliasSchema),
});

type SourceRef = {
  externalId: string;
  sourceId: TypeId<"source">;
  statedAt?: Date | undefined;
};

interface NodeForLLMPrompt {
  id: string;
  type: z.infer<typeof NodeTypeEnum>;
  label: string | null;
  timestamp: string;
  description?: string | null;
  tempId: string;
}

interface ProcessedNode {
  id: TypeId<"node">;
  label: string;
  description: string | undefined;
  nodeType: z.infer<typeof NodeTypeEnum>;
}

interface SimilarNodeForPrompt {
  id: TypeId<"node">;
  type: z.infer<typeof NodeTypeEnum>;
  label: string | null;
  description: string | null;
  timestamp: string;
}

interface ExtractGraphParams {
  userId: string;
  sourceType: SourceType;
  sourceId: TypeId<"source">;
  statedAt: Date;
  linkedNodeId: TypeId<"node">;
  sourceRefs?: SourceRef[];
  content: string;
}

// --- Main extractGraph function ---
export async function extractGraph({
  userId,
  sourceType,
  sourceId,
  statedAt,
  linkedNodeId,
  sourceRefs = [],
  content,
}: ExtractGraphParams) {
  const db = await useDatabase();
  const resolvedSourceRefs =
    sourceRefs.length > 0
      ? sourceRefs
      : [{ externalId: sourceId, sourceId, statedAt }];
  const sourceRefMap = new Map(
    resolvedSourceRefs.map((sourceRef) => [sourceRef.externalId, sourceRef]),
  );
  const sourceRefsForPrompt = resolvedSourceRefs
    .map(
      (sourceRef) =>
        `- sourceRef: ${sourceRef.externalId}${sourceRef.statedAt ? `; statedAt: ${safeToISOString(sourceRef.statedAt)}` : ""}`,
    )
    .join("\n");

  const [embeddingSimilar, oneHopNeighbors, allPersonNodes, openCommitments] =
    await Promise.all([
      findSimilarNodes({
        userId,
        text: content,
        limit: 50,
        minimumSimilarity: 0.3,
      }),
      findOneHopNodes(db, userId, [linkedNodeId]),
      findNodesByType(userId, "Person"),
      getOpenCommitments({ userId }),
    ]);

  const cappedOpenCommitments = openCommitments.slice(0, 20);

  // Deduplicate by node ID: open commitments first (so the LLM sees them),
  // then person nodes (most duplicated type), then embedding results, then
  // one-hop neighbors.
  const seenIds = new Set<TypeId<"node">>();
  const similarNodesForProcessing: SimilarNodeForPrompt[] = [];

  for (const commitment of cappedOpenCommitments) {
    if (seenIds.has(commitment.taskId)) continue;
    seenIds.add(commitment.taskId);
    similarNodesForProcessing.push({
      id: commitment.taskId,
      type: "Task",
      label: commitment.label,
      description: null,
      timestamp: safeToISOString(commitment.statedAt),
    });
  }

  for (const node of [
    ...allPersonNodes,
    ...embeddingSimilar,
    ...oneHopNeighbors,
  ]) {
    if (seenIds.has(node.id)) continue;
    seenIds.add(node.id);
    similarNodesForProcessing.push({
      id: node.id,
      type: node.type,
      label: node.label,
      description: node.description,
      timestamp: safeToISOString(node.timestamp),
    });
  }

  // Cap to keep the prompt manageable
  const cappedNodes = similarNodesForProcessing.slice(0, 150);

  const { nodesForPromptFormatting, idMap, nodeLabels } =
    _prepareInitialNodeMappings(cappedNodes);

  const openCommitmentsPromptSection = _formatOpenCommitmentsSection(
    cappedOpenCommitments,
  );

  const { createCompletionClient } = await import("./ai");
  const client = await createCompletionClient(userId);

  const prompt = `You are a knowledge graph extraction expert. Your task is to analyze the following ${sourceType} and extract entities, concepts, events, and their relationships to create a knowledge graph.

IMPORTANT:
- Do NOT respond to the content. Instead, analyze it and extract a structured graph representation.
${
  nodesForPromptFormatting.length > 0
    ? `
- Do NOT extract anything from the context—only from the ${sourceType} given at the end. The context is only provided to help you understand the ${sourceType} better.
	- I've provided some existing nodes that may be relevant to this ${sourceType}. If any of these nodes match entities in the ${sourceType}, use their 'tempId' (e.g., existing_person_1) in your 'nodes' or 'relationshipClaims' if you refer to them. DO NOT create new nodes for these if they match.

<context>
${formatNodesForPrompt(nodesForPromptFormatting)}
</context>
`
    : ""
}

${openCommitmentsPromptSection}

Extract the graph from the following ${sourceType}:

Allowed source refs:
${sourceRefsForPrompt}

<${sourceType}>
${content}
</${sourceType}>

CRITICAL EXTRACTION RULES - READ CAREFULLY:

When extracting from conversations:
- ONLY extract facts that the USER explicitly stated, confirmed, or provided
- DO NOT extract speculative statements, suggestions, or assumptions made by the assistant
- DO NOT treat assistant's questions as facts (e.g., "Are you working on X?" is NOT a fact that the user is working on X)
- DO NOT extract assistant's interpretations unless the user confirmed them
- If the assistant makes a statement and the user corrects it, ONLY extract the user's correction as fact
- Prioritize user's own statements about themselves, their experiences, preferences, and circumstances
- Be especially cautious with information only mentioned by the assistant - verify if the user confirmed it

EVERY claim (relationship and attribute) MUST include an "assertionKind" field. Use:
${
  sourceType === "document"
    ? `- "document_author" — for ALL claims extracted from this document. The document text is the asserter.`
    : `- "user" — the user explicitly stated this fact themselves (default for user-stated content).
- "user_confirmed" — the assistant said something and the user explicitly agreed (e.g., user replied "yes", "right", "exactly", "correct").
- "assistant_inferred" — used ONLY if you decide to extract something that the assistant said and the user did NOT confirm. Prefer to NOT extract these at all; if you must, mark them with this kind so they are demoted later.
- NEVER use "user" for an assistant-only statement.
- Do NOT emit "participant" — multi-party transcript ingestion is not yet supported.`
}

Few-shot examples:
${
  sourceType === "document"
    ? `- Document text: "The Eiffel Tower is located in Paris." → relationship claim with assertionKind: "document_author".`
    : `- User says "I started working at Acme last week." → assertionKind: "user".
- Assistant: "So you live in Paris now?" User: "Yes." → assertionKind: "user_confirmed" for the (user, LIVES_IN, Paris) claim (if extracted).
- Assistant: "It sounds like you might be a software engineer." User does not respond. → do NOT extract. If you must, assertionKind: "assistant_inferred".`
}

Extract, for example, the following elements:
1. People mentioned by the user (real or fictional)
2. Locations the user discussed or mentioned
3. Events that the user stated occurred or experienced
4. Objects or items the user mentioned as significant
5. Emotions the user expressed or discussed
6. Concepts or ideas the user explored or mentioned
7. Media the user mentioned (books, movies, articles, etc.)
8. Temporal references the user provided (dates, times, periods)
9. The user's preferences, goals, projects, and plans
10. Facts the user stated about other people or entities

For each element, create a node with:
- A unique temporary ID (format: "temp_[type]_[number]", e.g., "temp_person_1") if it's a NEW node.
- The appropriate node type
- A concise label (name/title)
- A brief description providing context (optional)

	Then, link these nodes with relationship claims and scalar attribute claims.
	- Claims represent sourced facts about nodes. For example, if you have a Person node and an Event node, create a claim from the Person node to the Event node with predicate PARTICIPATED_IN.
	- Relationship claims use objectId and a relationship predicate.
	- Attribute claims use objectValue and an attribute predicate, such as HAS_STATUS, HAS_PREFERENCE, HAS_GOAL, or MADE_DECISION.
	- ONLY create claims for facts explicitly stated by the user, not assistant assumptions.
	- In the claim statement, write one concise sentence that can stand alone as the sourced assertion.
		- Every claim must include a sourceRef copied exactly from the token after "sourceRef:" in the allowed source refs above. Do not include statedAt text.
	- Emit aliases when the source uses a nickname, abbreviation, alternate spelling, or shorter name for a node.
	- Ideally, relationship claims link to already-existing nodes. If the node isn't existing, create it.

Rules of the graph:
- Nodes are unique by type and label
- Never create new nodes for a node that already exists
- In node names use full names, eg. "John Doe" instead of "John"
- Omit unnecessary details in node names, eg. "John Doe" instead of "John Doe (person)"
- Nodes are independent of context and represent a *single* thing. Bad example: "John - the person taking a walk". Good example: "John" (Person node, no description) linked to [PARTICIPATED_IN] "John's walk on 2025-05-18" (Event node), linked to [OCCURRED_ON] "2025-05-18" (Temporal node).
- Don't create nodes for things that should be represented by edges.
- Avoid redundant or duplicate information - if a fact is already represented, don't create another node or edge for it

	Then create relationshipClaims and attributeClaims to represent the facts using the appropriate predicates.

Focus on extracting the most significant and meaningful information that the USER provided. Quality and accuracy are more important than quantity.`;

  const completion = await client.beta.chat.completions.parse({
    messages: [{ role: "user", content: prompt }],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
    response_format: zodResponseFormat(llmExtractionSchema, "subgraph"),
  });

  const parsedLlmOutput = completion.choices[0]?.message.parsed;
  if (!parsedLlmOutput) {
    throw new Error("Failed to parse LLM response");
  }

  const uniqueParsedLlmNodes = _deduplicateLlmNodes(parsedLlmOutput.nodes);
  const uniqueParsedLlmClaims = _deduplicateLlmClaims(
    parsedLlmOutput.relationshipClaims,
  );
  const uniqueParsedLlmAttributeClaims = _deduplicateLlmAttributeClaims(
    parsedLlmOutput.attributeClaims,
  );
  const uniqueParsedLlmAliases = _deduplicateLlmAliases(
    parsedLlmOutput.aliases,
  );

  const detailsOfNewlyCreatedNodes = await _processAndInsertNewNodes(
    db,
    userId,
    uniqueParsedLlmNodes,
    idMap,
    nodeLabels,
  );

  if (detailsOfNewlyCreatedNodes.length > 0) {
    await db
      .insert(sourceLinks)
      .values(
        detailsOfNewlyCreatedNodes.map((newNode) => ({
          sourceId,
          nodeId: newNode.id,
        })),
      )
      .onConflictDoNothing();
  }

  const deletedClaimRecords = await _deleteExistingClaimsForSources(
    db,
    userId,
    resolvedSourceRefs.map((sourceRef) => sourceRef.sourceId),
  );

  const insertedClaimRecords = await _processAndInsertLlmClaims(
    db,
    userId,
    statedAt,
    uniqueParsedLlmClaims,
    uniqueParsedLlmAttributeClaims,
    idMap,
    sourceRefMap,
    sourceType,
  );

  await _processAndInsertLlmAliases(db, userId, uniqueParsedLlmAliases, idMap);
  await applyClaimLifecycle(db, [
    ...deletedClaimRecords,
    ...insertedClaimRecords,
  ]);
  const finalizedClaimRecords = await fetchClaimsByIds(
    db,
    insertedClaimRecords.map((claim) => claim.id),
  );

  const claimsToEmbed = finalizedClaimRecords.map((claimRecord) => ({
    claimId: claimRecord.id,
    predicate: claimRecord.predicate,
    statement: claimRecord.statement,
    status: claimRecord.status,
    statedAt: claimRecord.statedAt,
  }));

  await Promise.all([
    generateAndInsertClaimEmbeddings(db, claimsToEmbed),
    generateAndInsertNodeEmbeddings(db, detailsOfNewlyCreatedNodes),
  ]);

  // Enqueue profile synthesis for each subject whose active claim set may have
  // changed: any subject of an inserted claim, or of a claim removed by the
  // source-scoped replacement. The job itself is idempotent via a content hash.
  const affectedSubjectNodeIds = _collectAffectedSubjectNodeIds(
    insertedClaimRecords,
    deletedClaimRecords,
  );
  if (affectedSubjectNodeIds.length > 0) {
    await enqueueProfileSynthesisJobs(userId, affectedSubjectNodeIds);
  }

  debugGraph(detailsOfNewlyCreatedNodes, finalizedClaimRecords);

  return {
    newNodesCreated: detailsOfNewlyCreatedNodes.length,
    claimsCreated: finalizedClaimRecords.length,
  };
}

function _collectAffectedSubjectNodeIds(
  insertedClaimRecords: Array<typeof claims.$inferSelect>,
  deletedClaimRecords: Array<typeof claims.$inferSelect>,
): TypeId<"node">[] {
  const seen = new Set<TypeId<"node">>();
  for (const record of insertedClaimRecords) seen.add(record.subjectNodeId);
  for (const record of deletedClaimRecords) seen.add(record.subjectNodeId);
  return [...seen];
}

async function enqueueProfileSynthesisJobs(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<void> {
  const { batchQueue } = await import("./queues");
  await Promise.all(
    nodeIds.map((nodeId) =>
      batchQueue.add(
        "profile-synthesis",
        { userId, nodeId },
        {
          jobId: `profile-synthesis:${userId}:${nodeId}`,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      ),
    ),
  );
}

async function _deleteExistingClaimsForSources(
  db: DrizzleDB,
  userId: string,
  sourceIds: TypeId<"source">[],
): Promise<Array<typeof claims.$inferSelect>> {
  const uniqueSourceIds = [...new Set(sourceIds)];
  if (uniqueSourceIds.length === 0) return [];

  return db
    .delete(claims)
    .where(
      and(eq(claims.userId, userId), inArray(claims.sourceId, uniqueSourceIds)),
    )
    .returning();
}

function _deduplicateLlmNodes(llmNodes: LlmOutputNode[]): LlmOutputNode[] {
  const seen = new Set<string>();
  return llmNodes.filter((node) => {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
    return true;
  });
}

function _deduplicateLlmClaims(
  llmClaims: LlmOutputRelationshipClaim[],
): LlmOutputRelationshipClaim[] {
  const seenClaimKeys = new Set<string>();
  return llmClaims.filter((claim) => {
    const key = `${claim.subjectId}|${claim.objectId}|${claim.predicate}|${claim.statement}|${claim.sourceRef}|${claim.assertionKind}`;
    if (seenClaimKeys.has(key)) return false;
    seenClaimKeys.add(key);
    return true;
  });
}

function _deduplicateLlmAttributeClaims(
  llmClaims: LlmOutputAttributeClaim[],
): LlmOutputAttributeClaim[] {
  const seenClaimKeys = new Set<string>();
  return llmClaims.filter((claim) => {
    const key = `${claim.subjectId}|${claim.predicate}|${claim.objectValue}|${claim.statement}|${claim.sourceRef}|${claim.assertionKind}`;
    if (seenClaimKeys.has(key)) return false;
    seenClaimKeys.add(key);
    return true;
  });
}

function _deduplicateLlmAliases(
  llmAliases: LlmOutputAlias[],
): LlmOutputAlias[] {
  const seenAliasKeys = new Set<string>();
  return llmAliases.filter((alias) => {
    const key = `${alias.subjectId}|${normalizeAliasText(alias.aliasText)}`;
    if (seenAliasKeys.has(key)) return false;
    seenAliasKeys.add(key);
    return true;
  });
}

function _formatOpenCommitmentsSection(
  openCommitments: OpenCommitment[],
): string {
  const header = `CURRENT OPEN TASKS:
These are the user's currently open Task nodes. Each line lists the task's existing nodeId, label, current status, owner, and due date. RULES:
- If the source mentions completing, abandoning, or progressing one of these tasks, emit an attribute claim with predicate \`HAS_TASK_STATUS\` (objectValue one of "pending", "in_progress", "done", "abandoned") whose subjectId is the task's existingNodeId shown below. DO NOT create a new Task node for it.
- Only emit \`HAS_TASK_STATUS\`, \`OWNED_BY\`, or \`DUE_ON\` claims for these existing tasks if their status, owner, or due date has actually changed in the source. Tasks whose state is unchanged should NOT be re-emitted.
- For brand-new tasks not in this list, create a new Task node with a temporary id (e.g. "temp_task_1") and emit \`HAS_TASK_STATUS=pending\` (and \`OWNED_BY\` / \`DUE_ON\` as applicable).`;

  if (openCommitments.length === 0) {
    return `${header}
- (no open tasks)`;
  }

  const lines = openCommitments.map((commitment) => {
    const label = commitment.label ?? "(unlabeled task)";
    const ownerPart = commitment.owner?.label
      ? `; owner: ${commitment.owner.label}`
      : commitment.owner
        ? `; ownerNodeId: ${commitment.owner.nodeId}`
        : "";
    const duePart = commitment.dueOn ? `; dueOn: ${commitment.dueOn}` : "";
    return `- existingNodeId: ${commitment.taskId}; label: ${label}; status: ${commitment.status}${ownerPart}${duePart}`;
  });

  return `${header}
${lines.join("\n")}`;
}

function _prepareInitialNodeMappings(similarNodes: SimilarNodeForPrompt[]) {
  const existingNodeMapper = new TemporaryIdMapper<
    SimilarNodeForPrompt,
    string
  >((item, index) => `existing_${item.type.toLowerCase()}_${index + 1}`);

  const mappedExistingNodes = existingNodeMapper.mapItems(similarNodes);

  const idMap = new Map<string, TypeId<"node">>();
  const nodeLabels = new Map<TypeId<"node">, string>();

  for (const mappedNode of mappedExistingNodes) {
    idMap.set(mappedNode.tempId, mappedNode.id);
    idMap.set(mappedNode.id.toString(), mappedNode.id);
    if (mappedNode.label) {
      nodeLabels.set(mappedNode.id, mappedNode.label);
    }
  }

  const nodesForPromptFormatting: NodeForLLMPrompt[] = mappedExistingNodes.map(
    (mappedNode) => ({
      id: mappedNode.id.toString(),
      type: mappedNode.type,
      label: mappedNode.label,
      description: mappedNode.description,
      tempId: mappedNode.tempId,
      timestamp: mappedNode.timestamp,
    }),
  );

  return { nodesForPromptFormatting, idMap, nodeLabels };
}

async function _processAndInsertNewNodes(
  db: DrizzleDB,
  userId: string,
  uniqueParsedLlmNodes: LlmOutputNode[],
  idMap: Map<string, TypeId<"node">>,
  nodeLabels: Map<TypeId<"node">, string>,
): Promise<ProcessedNode[]> {
  const detailsOfNewlyCreatedNodes: ProcessedNode[] = [];

  // Batch dedup: collect all canonical labels for nodes not already in idMap,
  // then look them all up in one query instead of N queries in the loop.
  const newLlmNodes = uniqueParsedLlmNodes.filter((n) => !idMap.has(n.id));
  const canonicalLabels = newLlmNodes.map((n) => normalizeLabel(n.label));
  const uniqueCanonicals = [...new Set(canonicalLabels)].filter(
    (c) => c !== "",
  );

  // Single batch query for all potential matches
  const existingMatches =
    uniqueCanonicals.length > 0
      ? await db
          .select({
            id: nodes.id,
            nodeType: nodes.nodeType,
            label: nodeMetadata.label,
            canonicalLabel: nodeMetadata.canonicalLabel,
          })
          .from(nodes)
          .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
          .where(
            and(
              eq(nodes.userId, userId),
              inArray(nodeMetadata.canonicalLabel, uniqueCanonicals),
            ),
          )
      : [];

  // Index by (nodeType, canonicalLabel) for O(1) lookup
  const existingByKey = new Map<
    string,
    { id: TypeId<"node">; label: string | null }
  >();
  for (const match of existingMatches) {
    const key = `${match.nodeType}|${match.canonicalLabel}`;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, { id: match.id, label: match.label });
    }
  }

  for (const llmNode of uniqueParsedLlmNodes) {
    if (idMap.has(llmNode.id)) {
      continue;
    }

    // Exact-match dedup: check batch results for existing node
    const canonical = normalizeLabel(llmNode.label);
    const existing = existingByKey.get(`${llmNode.type}|${canonical}`);

    if (existing) {
      idMap.set(llmNode.id, existing.id);
      if (existing.label) {
        nodeLabels.set(existing.id, existing.label);
      }
      continue;
    }

    const [insertedNodeRecord] = await db
      .insert(nodes)
      .values({
        userId,
        nodeType: llmNode.type,
      })
      .returning();

    if (!insertedNodeRecord) {
      console.warn(`Failed to insert node: ${llmNode.label}`);
      continue;
    }

    await db.insert(nodeMetadata).values({
      nodeId: insertedNodeRecord.id,
      label: llmNode.label,
      canonicalLabel: canonical,
      description: llmNode.description,
      additionalData: {},
    });

    idMap.set(llmNode.id, insertedNodeRecord.id);
    nodeLabels.set(insertedNodeRecord.id, llmNode.label);

    // Also add to batch lookup so subsequent LLM nodes with the same label
    // won't try to insert again
    existingByKey.set(`${llmNode.type}|${canonical}`, {
      id: insertedNodeRecord.id,
      label: llmNode.label,
    });

    detailsOfNewlyCreatedNodes.push({
      id: insertedNodeRecord.id,
      label: llmNode.label,
      description: llmNode.description,
      nodeType: llmNode.type,
    });
  }
  return detailsOfNewlyCreatedNodes;
}

async function _processAndInsertLlmClaims(
  db: DrizzleDB,
  userId: string,
  defaultStatedAt: Date,
  uniqueParsedLlmClaims: LlmOutputRelationshipClaim[],
  uniqueParsedLlmAttributeClaims: LlmOutputAttributeClaim[],
  idMap: Map<string, TypeId<"node">>,
  sourceRefMap: Map<string, SourceRef>,
  sourceType: SourceType,
): Promise<Array<typeof claims.$inferSelect>> {
  const claimInserts: Array<typeof claims.$inferInsert> = [];
  const sourceScopeMap = await _fetchSourceScopeMap(
    db,
    userId,
    [...sourceRefMap.values()].map((sourceRef) => sourceRef.sourceId),
  );

  for (const llmClaim of uniqueParsedLlmClaims) {
    const subjectNodeId = idMap.get(llmClaim.subjectId);
    const objectNodeId = idMap.get(llmClaim.objectId);
    const claimSource = _resolveClaimSource(
      llmClaim.sourceRef,
      llmClaim.statedAt,
      defaultStatedAt,
      sourceRefMap,
    );

    if (!subjectNodeId || !objectNodeId) {
      console.warn(
        `Skipping claim with invalid node references: ${llmClaim.subjectId} -> ${llmClaim.objectId}`,
      );
      continue;
    }

    if (!claimSource) {
      console.warn(
        `Skipping claim with invalid sourceRef: ${llmClaim.sourceRef}`,
      );
      continue;
    }

    const scope = sourceScopeMap.get(claimSource.sourceId);
    if (!scope) {
      console.warn(
        `Skipping claim with source outside user scope: ${llmClaim.sourceRef}`,
      );
      continue;
    }

    const assertedByKind = _resolveAssertedByKind(llmClaim, sourceType);
    if (assertedByKind === null) continue;

    claimInserts.push({
      userId,
      subjectNodeId,
      objectNodeId,
      predicate: llmClaim.predicate,
      statement: llmClaim.statement,
      description: llmClaim.statement,
      sourceId: claimSource.sourceId,
      scope,
      assertedByKind,
      statedAt: claimSource.statedAt,
      validFrom: _parseOptionalDate(llmClaim.validFrom),
      validTo: _parseOptionalDate(llmClaim.validTo),
      status: "active",
    });
  }

  for (const llmClaim of uniqueParsedLlmAttributeClaims) {
    const subjectNodeId = idMap.get(llmClaim.subjectId);
    const claimSource = _resolveClaimSource(
      llmClaim.sourceRef,
      llmClaim.statedAt,
      defaultStatedAt,
      sourceRefMap,
    );

    if (!subjectNodeId) {
      console.warn(
        `Skipping attribute claim with invalid node reference: ${llmClaim.subjectId}`,
      );
      continue;
    }

    if (!claimSource) {
      console.warn(
        `Skipping attribute claim with invalid sourceRef: ${llmClaim.sourceRef}`,
      );
      continue;
    }

    const scope = sourceScopeMap.get(claimSource.sourceId);
    if (!scope) {
      console.warn(
        `Skipping attribute claim with source outside user scope: ${llmClaim.sourceRef}`,
      );
      continue;
    }

    const assertedByKind = _resolveAssertedByKind(llmClaim, sourceType);
    if (assertedByKind === null) continue;

    claimInserts.push({
      userId,
      subjectNodeId,
      objectValue: llmClaim.objectValue,
      predicate: llmClaim.predicate,
      statement: llmClaim.statement,
      description: llmClaim.statement,
      sourceId: claimSource.sourceId,
      scope,
      assertedByKind,
      statedAt: claimSource.statedAt,
      validFrom: _parseOptionalDate(llmClaim.validFrom),
      validTo: _parseOptionalDate(llmClaim.validTo),
      status: "active",
    });
  }

  if (claimInserts.length === 0) {
    return [];
  }

  const insertedClaimRecords = await db
    .insert(claims)
    .values(claimInserts)
    .returning();

  return insertedClaimRecords;
}

async function _fetchSourceScopeMap(
  db: DrizzleDB,
  userId: string,
  sourceIds: TypeId<"source">[],
): Promise<Map<TypeId<"source">, Scope>> {
  const uniqueSourceIds = [...new Set(sourceIds)];
  if (uniqueSourceIds.length === 0) return new Map();

  const sourceRows = await db
    .select({ id: sources.id, scope: sources.scope })
    .from(sources)
    .where(
      and(eq(sources.userId, userId), inArray(sources.id, uniqueSourceIds)),
    );

  return new Map(sourceRows.map((source) => [source.id, source.scope]));
}

function _defaultAssertedByKind(sourceType: SourceType): AssertedByKind {
  if (sourceType === "document") return "document_author";
  return "user";
}

/**
 * Resolve the per-claim `assertedByKind`, defending against missing or
 * unsupported values from the LLM.
 *
 * - Null/undefined kind → fall back to per-sourceType default and warn.
 * - `participant` → unsupported until transcript ingestion lands; skip and warn.
 * - Otherwise → use the LLM's value.
 *
 * Returns `null` if the claim should be skipped.
 */
function _resolveAssertedByKind(
  llmClaim: {
    assertionKind?: AssertedByKind | undefined;
    assertedBySpeakerLabel?: string | undefined;
    sourceRef: string;
  },
  sourceType: SourceType,
): AssertedByKind | null {
  if (!llmClaim.assertionKind) {
    const fallback = _defaultAssertedByKind(sourceType);
    console.warn(
      `LLM omitted assertionKind for claim from sourceRef ${llmClaim.sourceRef}; falling back to ${fallback}.`,
    );
    return fallback;
  }

  if (llmClaim.assertionKind === "participant") {
    console.warn(
      `Skipping participant claim from sourceRef ${llmClaim.sourceRef}: transcript ingestion not yet supported.`,
    );
    return null;
  }

  return llmClaim.assertionKind;
}

async function _processAndInsertLlmAliases(
  db: DrizzleDB,
  userId: string,
  uniqueParsedLlmAliases: LlmOutputAlias[],
  idMap: Map<string, TypeId<"node">>,
): Promise<void> {
  for (const llmAlias of uniqueParsedLlmAliases) {
    const canonicalNodeId = idMap.get(llmAlias.subjectId);
    if (!canonicalNodeId) {
      console.warn(
        `Skipping alias with invalid node reference: ${llmAlias.subjectId}`,
      );
      continue;
    }

    if (normalizeAliasText(llmAlias.aliasText).length === 0) {
      console.warn(
        `Skipping empty alias for node reference: ${llmAlias.subjectId}`,
      );
      continue;
    }

    await createAlias(db, {
      userId,
      canonicalNodeId,
      aliasText: llmAlias.aliasText,
    });
  }
}

function _resolveClaimSource(
  sourceRef: string,
  statedAt: string | undefined,
  defaultStatedAt: Date,
  sourceRefMap: Map<string, SourceRef>,
): { sourceId: TypeId<"source">; statedAt: Date } | null {
  const source = sourceRefMap.get(sourceRef);
  if (!source) return null;

  return {
    sourceId: source.sourceId,
    statedAt:
      _parseOptionalDate(statedAt) ?? source.statedAt ?? defaultStatedAt,
  };
}

function _parseOptionalDate(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
