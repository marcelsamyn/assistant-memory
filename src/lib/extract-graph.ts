import { createAlias, normalizeAliasText } from "./alias";
import { applyClaimLifecycle, fetchClaimsByIds } from "./claims/lifecycle";
import { debugGraph } from "./debug-utils";
import {
  generateAndInsertNodeEmbeddings,
  generateAndInsertClaimEmbeddings,
} from "./embeddings-util";
import { formatNodesForPrompt } from "./formatting";
import { findSimilarNodes, findOneHopNodes, findNodesByType } from "./graph";
import { resolveIdentity } from "./identity-resolution";
import { normalizeLabel } from "./label";
import { recordMetricObservations } from "./metrics/observations";
import { getOpenCommitments } from "./query/open-commitments";
import { safeToISOString } from "./safe-date";
import { metricDefinitionInputSchema } from "./schemas/metric-write";
import { type OpenCommitment } from "./schemas/open-commitments";
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

const llmMetricEventObservationSchema = z.object({
  metric: metricDefinitionInputSchema,
  value: z.number(),
  note: z.string().nullable().optional(),
});

const llmMetricStandaloneObservationSchema =
  llmMetricEventObservationSchema.extend({
    occurredAt: z.string().datetime(),
  });

const llmMetricEventSchema = z.object({
  eventKey: z
    .string()
    .regex(/^[a-z0-9_-]{1,80}$/)
    .describe("stable event key unique within this extraction"),
  label: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  eventNodeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "optional temporary or existing Event node id when claims also reference it",
    ),
  observations: z.array(llmMetricEventObservationSchema),
});

const llmMetricsSchema = z.object({
  events: z.array(llmMetricEventSchema).optional(),
  standalone: z.array(llmMetricStandaloneObservationSchema).optional(),
});
type LlmOutputMetrics = z.infer<typeof llmMetricsSchema>;

const llmExtractionSchema = z.object({
  nodes: z.array(llmNodeSchema),
  relationshipClaims: z.array(llmRelationshipClaimSchema),
  attributeClaims: z.array(llmAttributeClaimSchema),
  aliases: z.array(llmAliasSchema),
  metrics: llmMetricsSchema.optional(),
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

/**
 * Resolved speaker entry passed in by transcript ingestion. Maps a raw
 * speaker label (as it appears in the transcript and on each child source's
 * metadata) to the Person nodeId it resolves to plus whether that node is
 * the user-self. The presence of a non-empty map switches the extraction
 * prompt and `_resolveAssertedByKind` into transcript mode.
 */
export interface SpeakerMapEntry {
  nodeId: TypeId<"node">;
  isUserSelf: boolean;
}

export type ExtractGraphSpeakerMap = Map<string, SpeakerMapEntry>;

interface ExtractGraphParams {
  userId: string;
  sourceType: SourceType;
  sourceId: TypeId<"source">;
  statedAt: Date;
  linkedNodeId: TypeId<"node">;
  sourceRefs?: SourceRef[];
  content: string;
  speakerMap?: ExtractGraphSpeakerMap;
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
  speakerMap,
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

  const speakerMapPromptSection = _formatSpeakerMapSection(speakerMap);

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

${speakerMapPromptSection}

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
    : speakerMap && speakerMap.size > 0
      ? `- "user" — the user-self speaker (see "Speakers in this transcript") asserted this fact.
- "user_confirmed" — the user-self speaker explicitly agreed with another speaker's statement.
- "participant" — another (non-user-self) speaker asserted this fact. Set "assertedBySpeakerLabel" to the EXACT label from the speaker list.
- "assistant_inferred" — only if you must extract something that no speaker actually said.
- For EVERY claim, also set "assertedBySpeakerLabel" to the speaker who said it, using the labels exactly as listed in "Speakers in this transcript". Unrecognized labels will cause the claim to be dropped.`
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
    : speakerMap && speakerMap.size > 0
      ? `- Speaker "Alice" (user-self) says "I shipped the spec." → assertionKind: "user", assertedBySpeakerLabel: "Alice".
- Speaker "Bob" (non user-self) says "I'll send the PR tomorrow." → assertionKind: "participant", assertedBySpeakerLabel: "Bob".
- Speaker "Bob" says "You're moving to Paris next month." Speaker "Alice" (user-self) replies "Yeah." → for the (Alice, LIVES_IN, Paris) claim use assertionKind: "user_confirmed", assertedBySpeakerLabel: "Alice".`
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

Optional numeric metrics:
- If the source contains numeric readings the user is tracking about themselves, emit them in the optional "metrics" object.
- Use metrics only for numeric time-series readings with units, such as body weight, running distance, running pace, average heart rate, sleep duration, sleep score, steps, or readiness score.
- Do not use metrics for booleans, moods, statuses, preferences, goals, plans, or one-off facts better represented as claims.
- Every metric must include a metric definition: slug, label, description, unit, and aggregationHint ("avg", "sum", "min", or "max").
- For readings tied to one event, group them in metrics.events[] with a stable eventKey, label, and occurredAt. If you also create an Event node for non-metric claims about the same event, put that node id in eventNodeId so the readings attach to it.
- For free-floating readings, put them in metrics.standalone[] with their own occurredAt.
- Store values in the canonical unit you declare. For durations, prefer seconds.

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

  const parentSourceScope = await _fetchSourceScope(db, userId, sourceId);

  const detailsOfNewlyCreatedNodes = await _processAndInsertNewNodes(
    db,
    userId,
    parentSourceScope,
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
    speakerMap,
  );

  await _processAndInsertLlmAliases(db, userId, uniqueParsedLlmAliases, idMap);
  await _processAndRecordLlmMetrics({
    userId,
    sourceId,
    metrics: parsedLlmOutput.metrics,
    idMap,
  });

  // Capture timestamp BEFORE lifecycle so the invalidation hook can detect
  // any claim that transitioned out of `active` during this run.
  const lifecycleStartedAt = new Date();
  await applyClaimLifecycle(db, [
    ...deletedClaimRecords,
    ...insertedClaimRecords,
  ]);
  const { maybeEnqueueAtlasInvalidation } = await import(
    "./jobs/atlas-invalidation"
  );
  await maybeEnqueueAtlasInvalidation(db, userId, lifecycleStartedAt);
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
  //
  // Identity re-evaluation runs from the same enqueue point (Phase 3.3): for
  // every affected node, run signals 3+4 against existing nodes and surface a
  // structured `identity.merge_proposal` log line on positive hits. Embedding
  // generation above is inline (Promise.all is awaited before this point), so
  // the reeval worker is guaranteed to see the new embedding for nodes that
  // were just created here.
  const affectedSubjectNodeIds = _collectAffectedSubjectNodeIds(
    insertedClaimRecords,
    deletedClaimRecords,
  );
  // Profile synthesis is the expensive trigger (one LLM call per node), so we
  // gate it on whether the durable profile could actually have moved: only
  // attribute-predicate claim changes feed the synthesis prompt. Relationship
  // changes still trigger identity-reeval (cheap, SQL/pgvector only).
  const attributeAffectedSubjectNodeIds =
    _collectAttributeAffectedSubjectNodeIds(
      insertedClaimRecords,
      deletedClaimRecords,
    );
  if (
    affectedSubjectNodeIds.length > 0 ||
    attributeAffectedSubjectNodeIds.length > 0
  ) {
    await Promise.all([
      enqueueProfileSynthesisJobs(userId, attributeAffectedSubjectNodeIds),
      enqueueIdentityReevalJobs(userId, affectedSubjectNodeIds),
    ]);
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

const ATTRIBUTE_PREDICATE_SET: ReadonlySet<string> = new Set(
  AttributePredicateEnum.options,
);

export function _collectAttributeAffectedSubjectNodeIds(
  insertedClaimRecords: Array<typeof claims.$inferSelect>,
  deletedClaimRecords: Array<typeof claims.$inferSelect>,
): TypeId<"node">[] {
  const seen = new Set<TypeId<"node">>();
  for (const record of insertedClaimRecords) {
    if (ATTRIBUTE_PREDICATE_SET.has(record.predicate)) {
      seen.add(record.subjectNodeId);
    }
  }
  for (const record of deletedClaimRecords) {
    if (ATTRIBUTE_PREDICATE_SET.has(record.predicate)) {
      seen.add(record.subjectNodeId);
    }
  }
  return [...seen];
}

// Debounce window: a multi-message burst that touches the same node within
// this window collapses to one synthesis. The job reads current state at run
// time, so the run captures every change in the burst, not just the trigger.
const PROFILE_SYNTHESIS_DEBOUNCE_MS = 5 * 60_000;

async function enqueueProfileSynthesisJobs(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<void> {
  if (nodeIds.length === 0) return;
  const { batchQueue } = await import("./queues");
  await Promise.all(
    nodeIds.map((nodeId) =>
      batchQueue.add(
        "profile-synthesis",
        { userId, nodeId },
        {
          jobId: `profile-synthesis:${userId}:${nodeId}`,
          delay: PROFILE_SYNTHESIS_DEBOUNCE_MS,
          removeOnComplete: true,
          removeOnFail: 50,
        },
      ),
    ),
  );
}

async function enqueueIdentityReevalJobs(
  userId: string,
  nodeIds: TypeId<"node">[],
): Promise<void> {
  if (nodeIds.length === 0) return;
  const { batchQueue } = await import("./queues");
  await Promise.all(
    nodeIds.map((nodeId) =>
      batchQueue.add(
        "identity-reeval",
        { userId, nodeId },
        {
          jobId: `identity-reeval:${userId}:${nodeId}`,
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

async function _fetchSourceScope(
  db: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<Scope> {
  const [row] = await db
    .select({ scope: sources.scope })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)))
    .limit(1);
  // Source must exist by the time extraction runs; default defensively to
  // personal so we never silently widen scope on a misconfigured source.
  return row?.scope ?? "personal";
}

async function _processAndInsertNewNodes(
  db: DrizzleDB,
  userId: string,
  scope: Scope,
  uniqueParsedLlmNodes: LlmOutputNode[],
  idMap: Map<string, TypeId<"node">>,
  nodeLabels: Map<TypeId<"node">, string>,
): Promise<ProcessedNode[]> {
  const detailsOfNewlyCreatedNodes: ProcessedNode[] = [];

  // Local cache so two LLM nodes with the same (type, canonical) within one
  // extraction collapse to the same id without re-running identity
  // resolution. The previous batched query did the same; we preserve that.
  const localByKey = new Map<string, TypeId<"node">>();

  for (const llmNode of uniqueParsedLlmNodes) {
    if (idMap.has(llmNode.id)) {
      continue;
    }

    const canonical = normalizeLabel(llmNode.label);
    const localKey = `${llmNode.type}|${canonical}`;
    const localHit = localByKey.get(localKey);
    if (localHit) {
      idMap.set(llmNode.id, localHit);
      const cachedLabel = nodeLabels.get(localHit);
      if (cachedLabel) {
        nodeLabels.set(localHit, cachedLabel);
      }
      continue;
    }

    // Identity resolution: signals 1 (canonical label) and 2 (alias) are the
    // ones we can run pre-embedding. Signals 3 (embedding similarity) and 4
    // (claim profile compat) require artifacts that don't exist yet for a
    // not-yet-inserted node, so they're left to the background re-evaluation
    // pass (Phase 3.3).
    const resolution = await resolveIdentity({
      userId,
      candidate: {
        proposedLabel: llmNode.label,
        normalizedLabel: canonical,
        nodeType: llmNode.type,
        scope,
      },
    });

    if (resolution.resolvedNodeId) {
      idMap.set(llmNode.id, resolution.resolvedNodeId);
      localByKey.set(localKey, resolution.resolvedNodeId);
      const [existingMetadata] = await db
        .select({ label: nodeMetadata.label })
        .from(nodeMetadata)
        .where(eq(nodeMetadata.nodeId, resolution.resolvedNodeId))
        .limit(1);
      if (existingMetadata?.label) {
        nodeLabels.set(resolution.resolvedNodeId, existingMetadata.label);
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
    localByKey.set(localKey, insertedNodeRecord.id);

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
  speakerMap: ExtractGraphSpeakerMap | undefined,
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

    const provenance = _resolveAssertedByKind(llmClaim, sourceType, speakerMap);
    if (provenance === null) continue;

    claimInserts.push({
      userId,
      subjectNodeId,
      objectNodeId,
      predicate: llmClaim.predicate,
      statement: llmClaim.statement,
      description: llmClaim.statement,
      sourceId: claimSource.sourceId,
      scope,
      assertedByKind: provenance.kind,
      assertedByNodeId: provenance.nodeId,
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

    const provenance = _resolveAssertedByKind(llmClaim, sourceType, speakerMap);
    if (provenance === null) continue;

    claimInserts.push({
      userId,
      subjectNodeId,
      objectValue: llmClaim.objectValue,
      predicate: llmClaim.predicate,
      statement: llmClaim.statement,
      description: llmClaim.statement,
      sourceId: claimSource.sourceId,
      scope,
      assertedByKind: provenance.kind,
      assertedByNodeId: provenance.nodeId,
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

async function _processAndRecordLlmMetrics({
  userId,
  sourceId,
  metrics,
  idMap,
}: {
  userId: string;
  sourceId: TypeId<"source">;
  metrics: LlmOutputMetrics | undefined;
  idMap: Map<string, TypeId<"node">>;
}): Promise<void> {
  const observations = (metrics?.standalone ?? []).map((observation) => ({
    metric: observation.metric,
    value: observation.value,
    occurredAt: new Date(observation.occurredAt),
    note: observation.note ?? null,
  }));

  const events = (metrics?.events ?? []).flatMap((event) => {
    const eventNodeId =
      event.eventNodeId === undefined
        ? undefined
        : idMap.get(event.eventNodeId);
    if (event.eventNodeId !== undefined && eventNodeId === undefined) {
      console.warn(
        `Metric event will create its own node because the referenced node was not found: ${event.eventNodeId}`,
      );
    }

    if (eventNodeId !== undefined) {
      observations.push(
        ...event.observations.map((observation) => ({
          metric: observation.metric,
          value: observation.value,
          occurredAt: new Date(event.occurredAt),
          note: observation.note ?? null,
          eventNodeId,
        })),
      );
      return [];
    }

    return [
      {
        eventKey: event.eventKey,
        label: event.label,
        occurredAt: new Date(event.occurredAt),
        observations: event.observations.map((observation) => ({
          metric: observation.metric,
          value: observation.value,
          note: observation.note ?? null,
        })),
      },
    ];
  });

  if (observations.length === 0 && events.length === 0) return;
  await recordMetricObservations({
    userId,
    source: { sourceId },
    createDefinitions: true,
    replaceSourceObservations: true,
    events,
    observations,
  });
}

function _defaultAssertedByKind(sourceType: SourceType): AssertedByKind {
  if (sourceType === "document") return "document_author";
  return "user";
}

interface ResolvedProvenance {
  kind: AssertedByKind;
  /** Required (and only allowed) when `kind === 'participant'`. */
  nodeId: TypeId<"node"> | null;
}

/**
 * Resolve the per-claim `assertedByKind` (and `assertedByNodeId` for
 * participants), defending against missing or unsupported values from the
 * LLM.
 *
 * Without a `speakerMap`, behavior is unchanged from PR 4i:
 *   - Null/undefined kind → fall back to per-sourceType default and warn.
 *   - `participant` → unsupported; skip and warn.
 *   - Otherwise → use the LLM's value.
 *
 * With a `speakerMap` (transcript ingestion), `assertedBySpeakerLabel` is
 * required and resolved through the map:
 *   - user-self speaker → `kind = 'user'`.
 *   - any other resolved speaker → `kind = 'participant'`,
 *     `nodeId = resolved nodeId`.
 *   - unresolvable label → reject the claim with a warning.
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
  speakerMap: ExtractGraphSpeakerMap | undefined,
): ResolvedProvenance | null {
  if (speakerMap && speakerMap.size > 0) {
    return _resolveTranscriptProvenance(llmClaim, speakerMap);
  }

  if (!llmClaim.assertionKind) {
    const fallback = _defaultAssertedByKind(sourceType);
    console.warn(
      `LLM omitted assertionKind for claim from sourceRef ${llmClaim.sourceRef}; falling back to ${fallback}.`,
    );
    return { kind: fallback, nodeId: null };
  }

  if (llmClaim.assertionKind === "participant") {
    console.warn(
      `Skipping participant claim from sourceRef ${llmClaim.sourceRef}: transcript ingestion not yet supported.`,
    );
    return null;
  }

  return { kind: llmClaim.assertionKind, nodeId: null };
}

function _resolveTranscriptProvenance(
  llmClaim: {
    assertionKind?: AssertedByKind | undefined;
    assertedBySpeakerLabel?: string | undefined;
    sourceRef: string;
  },
  speakerMap: ExtractGraphSpeakerMap,
): ResolvedProvenance | null {
  const label = llmClaim.assertedBySpeakerLabel?.trim();
  if (!label) {
    console.warn(
      `Skipping transcript claim from sourceRef ${llmClaim.sourceRef}: missing assertedBySpeakerLabel.`,
    );
    return null;
  }
  const speaker = _lookupSpeaker(speakerMap, label);
  if (!speaker) {
    console.warn(
      `Skipping transcript claim from sourceRef ${llmClaim.sourceRef}: unresolvable speaker label '${label}'.`,
    );
    return null;
  }
  if (speaker.isUserSelf) {
    // Honor an explicit `user_confirmed` only; otherwise collapse to `user`.
    const kind: AssertedByKind =
      llmClaim.assertionKind === "user_confirmed" ? "user_confirmed" : "user";
    return { kind, nodeId: null };
  }
  return { kind: "participant", nodeId: speaker.nodeId };
}

function _lookupSpeaker(
  speakerMap: ExtractGraphSpeakerMap,
  label: string,
): SpeakerMapEntry | undefined {
  const direct = speakerMap.get(label);
  if (direct) return direct;
  // Case-insensitive fallback so the LLM doesn't have to match casing
  // exactly (the prompt asks it to, but the model occasionally normalizes).
  const target = label.toLowerCase();
  for (const [key, value] of speakerMap.entries()) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function _formatSpeakerMapSection(
  speakerMap: ExtractGraphSpeakerMap | undefined,
): string {
  if (!speakerMap || speakerMap.size === 0) return "";
  const lines = [...speakerMap.entries()].map(([label, entry]) => {
    const role = entry.isUserSelf ? "user-self" : "other-participant";
    return `- speakerLabel: ${label}; nodeId: ${entry.nodeId}; role: ${role}`;
  });
  return `Speakers in this transcript:
For each claim, set "assertedBySpeakerLabel" to the speaker who said it, using these labels exactly. Claims whose speaker label is missing or not in this list will be dropped.
${lines.join("\n")}`;
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
