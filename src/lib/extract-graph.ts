import { debugGraph } from "./debug-utils";
import {
  generateAndInsertNodeEmbeddings,
  generateAndInsertClaimEmbeddings,
} from "./embeddings-util";
import { formatNodesForPrompt } from "./formatting";
import { findSimilarNodes, findOneHopNodes, findNodesByType } from "./graph";
import { normalizeLabel } from "./label";
import { safeToISOString } from "./safe-date";
import { TemporaryIdMapper } from "./temporary-id-mapper";
import { and, eq, inArray } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import { type DrizzleDB } from "~/db";
import { claims, nodeMetadata, nodes, sourceLinks } from "~/db/schema";
import {
  NodeTypeEnum,
  RelationshipPredicateEnum,
  SourceType,
} from "~/types/graph";
import { type TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

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
});
type LlmOutputRelationshipClaim = z.infer<typeof llmRelationshipClaimSchema>;

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
  sourceRefs?: Array<{ externalId: string; sourceId: TypeId<"source"> }>;
  content: string;
}

// --- Main extractGraph function ---
export async function extractGraph({
  userId,
  sourceType,
  sourceId,
  statedAt,
  linkedNodeId,
  content,
}: ExtractGraphParams) {
  const db = await useDatabase();

  const [embeddingSimilar, oneHopNeighbors, allPersonNodes] = await Promise.all(
    [
      findSimilarNodes({
        userId,
        text: content,
        limit: 50,
        minimumSimilarity: 0.3,
      }),
      findOneHopNodes(db, userId, [linkedNodeId]),
      findNodesByType(userId, "Person"),
    ],
  );

  // Deduplicate by node ID: person nodes first (most duplicated type),
  // then embedding results, then one-hop neighbors
  const seenIds = new Set<TypeId<"node">>();
  const similarNodesForProcessing: SimilarNodeForPrompt[] = [];

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

Extract the graph from the following ${sourceType}:

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

	Then, link these nodes with relationship claims.
	- Claims represent sourced facts about nodes. For example, if you have a Person node and an Event node, create a claim from the Person node to the Event node with predicate PARTICIPATED_IN.
	- ONLY create claims for facts explicitly stated by the user, not assistant assumptions.
	- In the claim statement, write one concise sentence that can stand alone as the sourced assertion.
	- Ideally, edges link to already-existing nodes. If the node isn't existing, create it.

Rules of the graph:
- Nodes are unique by type and label
- Never create new nodes for a node that already exists
- In node names use full names, eg. "John Doe" instead of "John"
- Omit unnecessary details in node names, eg. "John Doe" instead of "John Doe (person)"
- Nodes are independent of context and represent a *single* thing. Bad example: "John - the person taking a walk". Good example: "John" (Person node, no description) linked to [PARTICIPATED_IN] "John's walk on 2025-05-18" (Event node), linked to [OCCURRED_ON] "2025-05-18" (Temporal node).
- Don't create nodes for things that should be represented by edges.
- Avoid redundant or duplicate information - if a fact is already represented, don't create another node or edge for it

	Then create relationshipClaims between these nodes to represent their relationships using the appropriate predicates.

Focus on extracting the most significant and meaningful information that the USER provided. Quality and accuracy are more important than quantity.`;

  const completion = await client.beta.chat.completions.parse({
    messages: [{ role: "user", content: prompt }],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
    response_format: zodResponseFormat(
      z.object({
        nodes: z.array(llmNodeSchema),
        relationshipClaims: z.array(llmRelationshipClaimSchema),
      }),
      "subgraph",
    ),
  });

  const parsedLlmOutput = completion.choices[0]?.message.parsed;
  if (!parsedLlmOutput) {
    throw new Error("Failed to parse LLM response");
  }

  const uniqueParsedLlmNodes = _deduplicateLlmNodes(parsedLlmOutput.nodes);
  const uniqueParsedLlmClaims = _deduplicateLlmClaims(
    parsedLlmOutput.relationshipClaims,
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

  const insertedClaimRecords = await _processAndInsertLlmClaims(
    db,
    userId,
    sourceId,
    statedAt,
    uniqueParsedLlmClaims,
    idMap,
  );

  const claimsToEmbed = insertedClaimRecords.map((claimRecord) => ({
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

  debugGraph(detailsOfNewlyCreatedNodes, insertedClaimRecords);

  return {
    newNodesCreated: detailsOfNewlyCreatedNodes.length,
    claimsCreated: insertedClaimRecords.length,
  };
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
    const key = `${claim.subjectId}|${claim.objectId}|${claim.predicate}|${claim.statement}`;
    if (seenClaimKeys.has(key)) return false;
    seenClaimKeys.add(key);
    return true;
  });
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
  sourceId: TypeId<"source">,
  statedAt: Date,
  uniqueParsedLlmClaims: LlmOutputRelationshipClaim[],
  idMap: Map<string, TypeId<"node">>,
): Promise<Array<typeof claims.$inferSelect>> {
  const claimInserts: Array<typeof claims.$inferInsert> = [];

  for (const llmClaim of uniqueParsedLlmClaims) {
    const subjectNodeId = idMap.get(llmClaim.subjectId);
    const objectNodeId = idMap.get(llmClaim.objectId);

    if (!subjectNodeId || !objectNodeId) {
      console.warn(
        `Skipping claim with invalid node references: ${llmClaim.subjectId} -> ${llmClaim.objectId}`,
      );
      continue;
    }

    claimInserts.push({
      userId,
      subjectNodeId,
      objectNodeId,
      predicate: llmClaim.predicate,
      statement: llmClaim.statement,
      description: llmClaim.statement,
      sourceId,
      statedAt,
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
