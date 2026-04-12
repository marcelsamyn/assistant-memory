import { addDays, formatISO } from "date-fns";
import { safeToISOString } from "~/lib/safe-date";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { nodes, nodeMetadata, nodeEmbeddings, edges } from "~/db/schema";
import { crateTextCompletion, performStructuredAnalysis } from "~/lib/ai";
import { generateEmbeddings } from "~/lib/embeddings";
import { formatNodesForPrompt } from "~/lib/formatting";
import { findSimilarNodes, type NodeSearchResult } from "~/lib/graph";
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import { useDatabase } from "~/utils/db";

export const DreamJobDataSchema = z.object({
  userId: z.string(),
  assistantDescription: z.string(),
});

export type DreamJobData = z.infer<typeof DreamJobDataSchema>;

// High-level dream workflow
export async function dream(data: DreamJobData): Promise<void> {
  const { userId, assistantDescription } = data;
  if (Math.random() > env.DREAM_PROBABILITY) return;

  const db = await useDatabase();
  const date = formatISO(addDays(new Date(), -1), { representation: "date" });
  const dayNode = await fetchDayNode(db, date);
  if (!dayNode) return;

  const topics = await proposeTopics(userId, date, assistantDescription);
  await Promise.all(
    topics
      .filter(() => Math.random() < env.DREAM_SELECTION_PROBABILITY)
      .map((t) => handleTopic(db, userId, assistantDescription, dayNode.id, t)),
  );
}

// 1. Find the day node for a given date
async function fetchDayNode(db: DrizzleDB, date: string) {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
    .where(eq(nodeMetadata.label, date))
    .limit(1);
  return rows[0] ?? null;
}

// 2. Ask the LLM for up to 3 dream topics
async function proposeTopics(
  userId: string,
  date: string,
  systemPrompt: string,
): Promise<string[]> {
  const ctx = `Memories from ${date}`;
  const TopicSchema = z
    .object({ topics: z.array(z.string()).max(3) })
    .describe("DreamTopic");
  const { topics } = await performStructuredAnalysis({
    userId,
    systemPrompt,
    prompt: `<system:info>You are now in a "dream" state. This is space for you to have internal (hidden from any users) dreams, thoughts and insights. The past day is ${date}. </system:info>

<context about="nodes from knowledge graph linked to today">
${ctx}
</context>

<system:instruction>
Suggest up to 3 topics, questions or dream scenarios to start off with. This can be as short as a single topic or an entire dream that you're thinking of. If there's nothing relevant, just return an empty array. It's okay to stop here if there's nothing relvant.
</system:instruction>
`,
    schema: TopicSchema,
  });
  return topics;
}

// 3–6. For each topic, conduct a structured dream flow
async function handleTopic(
  db: DrizzleDB,
  userId: string,
  systemPrompt: string,
  dayId: TypeId<"node">,
  topic: string,
) {
  const queries = await proposeQueries(userId, systemPrompt, topic);
  const nodes = await retrieveRelevantNodes(userId, queries);
  const nodesForPrompt = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label,
    description: n.description,
    tempId: n.id,
    timestamp: safeToISOString(n.timestamp),
  }));
  const context = formatNodesForPrompt(nodesForPrompt);
  const dream = await generateDreamContent(
    userId,
    systemPrompt,
    topic,
    context,
  );
  const score = await scoreDream(userId, systemPrompt, dream);
  if (score < 0.7) return;
  await persistDream(db, userId, dayId, topic, dream);
}

// 1. Structured analysis: propose search queries
async function proposeQueries(
  userId: string,
  systemPrompt: string,
  topic: string,
): Promise<string[]> {
  const schema = z
    .object({ queries: z.array(z.string()).min(1).max(3) })
    .describe("DreamQuery");
  const res = await performStructuredAnalysis({
    userId,
    systemPrompt,
    prompt: `<system:info>You are now in a "dream" state. This is space for you to have internal (hidden from any users) dreams, thoughts and insights.</system:info>

Previously, you chose the following to dream about:

<dream:topic>${topic}</dream:topic>

<system:instruction>
If you want more information, fetched from a semantic graph database built from your previous interactions with the user and potentially information from various sources inserted by the user, return 1-3 search queries. These will be used as semantic search query and are fine-tuned to return the information most likely to be able to answer the given question(s).
</system:instruction>
`,
    schema,
  });
  return res["queries"];
}

// 2. Retrieve relevant nodes via semantic search
async function retrieveRelevantNodes(
  userId: string,
  queries: string[],
): Promise<NodeSearchResult[]> {
  const map = new Map<string, NodeSearchResult>();
  for (const q of queries) {
    const results = await findSimilarNodes({
      userId,
      text: q,
      limit: 10,
      minimumSimilarity: 0.4,
    });
    results.forEach((n) => map.set(n.id, n));
  }
  return Array.from(map.values());
}

// 3. Generate the dream content via LLM
async function generateDreamContent(
  userId: string,
  systemPrompt: string,
  topic: string,
  context: string,
): Promise<string> {
  return await crateTextCompletion({
    userId,
    systemPrompt,
    prompt: `
<system:info>
You are now in a "dream" state. This is space for you to have internal (hidden from any users) dreams, thoughts and insights.
</system:info>

<context about="The topic you picked earlier to dream about.">
${topic}
</context>

<context about="Possible related entries from the memory, fetched via semantic search.">
${context}
</context>

<system:instruction>
Write down this dream. Think about the topic, what it means in the larger scheme of things, how the dream progresses, what you see, hear, what happens in the dream, etc. Then interpret this dream, take in all the information you've gathered and draw conclusions. Think about what this means for the user and how it can be used to help them, or just what for you as an assistant (it doesn't strictly have to be aimed at the user specifically). If there are any resolutions or conclusions, definitely note those down as well.

If you don't have anything to say, just return an empty string.
</system:instruction>
    `,
  });
}

// 4. Structured analysis: score the dream quality
async function scoreDream(
  userId: string,
  systemPrompt: string,
  dream: string,
): Promise<number> {
  const schema = z.object({ score: z.number() }).describe("DreamScore");
  const res = await performStructuredAnalysis({
    userId,
    systemPrompt,
    prompt: `
<system:info>
You are now in a "dream" state. This is space for you to have internal (hidden from any users) dreams, thoughts and insights.
</system:info>

<context about="The dream you just wrote down.">
${dream}
</context>

<system:instruction>
Rate the following dream on a 0–1 scale for relevance and usefulness. If you don't have anything to say, just return 0.
</system:instruction>
`,
    schema,
  });
  return res["score"];
}

// Persist a finished dream
async function persistDream(
  db: DrizzleDB,
  userId: string,
  dayId: TypeId<"node">,
  label: string,
  dreamContent: string,
) {
  const inserted = await db
    .insert(nodes)
    .values({
      userId,
      nodeType: NodeTypeEnum.enum.AssistantDream,
      createdAt: new Date(),
    })
    .returning({ id: nodes.id });
  if (!inserted.length) return;
  const newNode = inserted[0]!;
  await db.insert(nodeMetadata).values({
    nodeId: newNode.id,
    label,
    description: dreamContent,
  });
  const emb = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: [dreamContent],
    truncate: true,
  });
  await db.insert(nodeEmbeddings).values({
    nodeId: newNode.id,
    modelName: "jina-embeddings-v3",
    embedding: emb.data[0]!.embedding,
  });
  await db.insert(edges).values({
    userId,
    sourceNodeId: dayId,
    targetNodeId: newNode.id,
    edgeType: "CAPTURED_IN",
  });
}
