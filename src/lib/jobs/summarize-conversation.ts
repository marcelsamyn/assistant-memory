import { eq, and, ne } from "drizzle-orm";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { nodeMetadata, sources, sourceLinks, nodes } from "~/db/schema";
import {
  loadConversationTurns,
  type ConversationTurn,
} from "~/lib/conversation-store";
import { debug } from "~/lib/debug-utils";
import { formatConversationAsXml } from "~/lib/formatting";
import { env } from "~/utils/env";

// Job input schema
export const SummarizeConversationJobInputSchema = z.object({
  userId: z.string(),
});
export type SummarizeConversationJobInput = z.infer<
  typeof SummarizeConversationJobInputSchema
>;

// Define the expected output/result of the job
export interface SummarizeConversationJobResult {
  message: string;
  summarizedCount: number;
}

/**
 * Summarizes conversations for a given user.
 * Fetches conversations needing summarization, calls OpenAI, and updates metadata.
 */
export async function summarizeUserConversations(
  db: DrizzleDB,
  userId: string,
): Promise<SummarizeConversationJobResult> {
  const convsToSummarize = await db
    .select({ sourceId: sources.id, conversationNodeId: sourceLinks.nodeId })
    .from(sources)
    .innerJoin(sourceLinks, eq(sourceLinks.sourceId, sources.id))
    .innerJoin(nodes, eq(nodes.id, sourceLinks.nodeId))
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.type, "conversation"),
        ne(sources.status, "summarized"),
      ),
    );

  if (convsToSummarize.length === 0) {
    return {
      message: "No new conversations found to summarize.",
      summarizedCount: 0,
    };
  }

  let summarizedCount = 0;
  const { createCompletionClient } = await import("../ai");
  const client = await createCompletionClient(userId);

  for (const { sourceId, conversationNodeId } of convsToSummarize) {
    // load conversation turns
    let turns: ConversationTurn[];
    try {
      turns = await loadConversationTurns(db, userId, sourceId);
    } catch (err: unknown) {
      console.error(`Error loading turns for source ${sourceId}:`, err);
      await db
        .update(sources)
        .set({ status: "failed" })
        .where(eq(sources.id, sourceId));
      continue;
    }
    if (turns.length === 0) {
      await db
        .update(sources)
        .set({ status: "summarized" })
        .where(eq(sources.id, sourceId));
      continue;
    }

    const prompt = `You are a conversation summarizer extracting facts for a personal knowledge graph.

CRITICAL: Only capture facts the USER explicitly stated. The assistant may speculate, infer, or make things up—do NOT treat assistant statements as facts about the user unless the user confirmed them.

Return (a) a title and (b) a summary with concise, information-dense bullet points.

**Prioritize user-stated information:**
- Facts the user directly shared about themselves, their life, work, relationships
- Names, places, dates, preferences, opinions the user mentioned
- Experiences, events, or stories the user described
- Emotions or feelings the user expressed
- Decisions or intentions the user stated
- Questions or topics the user wanted to explore

**Include selectively (only if clearly grounded):**
- People mentioned by name and their relationship to the user
- Key conclusions or insights the user arrived at (not the assistant's suggestions)
- Action items or next steps the user committed to

**Exclude:**
- Assistant speculation about the user ("you might be...", "perhaps you feel...")
- Assistant suggestions the user didn't explicitly accept
- Generic advice or information the assistant provided
- Anything uncertain or inferred—when in doubt, leave it out

Format: Use headers only when there are items for that section. Omit empty sections entirely.

<conversation>
${formatConversationAsXml(turns)}
</conversation>
`;

    debug(`Summarize - prompt for source ${sourceId}:`, prompt);
    try {
      const completion = await client.beta.chat.completions.parse({
        messages: [{ role: "user", content: prompt }],
        model: env.MODEL_ID_GRAPH_EXTRACTION,
        response_format: zodResponseFormat(
          z.object({
            title: z
              .string()
              .describe(
                "A concise title for the summary, max length 255 characters",
              ),
            summary: z
              .string()
              .describe("A concise summary of the conversation"),
          }),
          "summary",
        ),
      });

      const parsed = completion.choices[0]?.message.parsed;
      debug(`Summarize - parsed result for source ${sourceId}:`, parsed);

      if (!parsed) {
        console.error(`Failed to parse LLM response for source ${sourceId}`);
        await db
          .update(sources)
          .set({ status: "failed" })
          .where(eq(sources.id, sourceId));
        continue;
      }

      const metadataInsert = {
        nodeId: conversationNodeId,
        label: parsed.title,
        description: parsed.summary,
      };
      await db
        .insert(nodeMetadata)
        .values(metadataInsert)
        .onConflictDoUpdate({
          target: nodeMetadata.nodeId,
          set: {
            label: parsed.title,
            description: parsed.summary,
          },
        });

      await db
        .update(sources)
        .set({
          status: "summarized",
        })
        .where(eq(sources.id, sourceId));

      summarizedCount++;
    } catch (error) {
      // The OpenAI SDK's parseChatCompletion crashes with
      // `TypeError: Cannot read properties of undefined (reading 'map')`
      // when the upstream API returns a response without a `choices` field
      // (e.g. an error envelope from a custom baseURL provider, an empty
      // body, or a rate-limit response wrapped as 200). Treat this as a
      // transient upstream issue: leave the source untouched so the next
      // batch retries it instead of permanently marking it failed.
      if (
        error instanceof TypeError &&
        error.message.includes("reading 'map'") &&
        typeof error.stack === "string" &&
        error.stack.includes("parseChatCompletion")
      ) {
        console.warn(
          `Summarize - upstream returned malformed completion for source ${sourceId}; leaving for retry on next batch`,
        );
        continue;
      }
      console.error(`Error summarizing source ${sourceId}:`, error);
      await db
        .update(sources)
        .set({ status: "failed" })
        .where(eq(sources.id, sourceId));
      // Do not re-throw here, allow the loop to continue with other sources
    }
  }

  return {
    message: `Finished summarizing. Processed ${summarizedCount} out of ${convsToSummarize.length} conversations requiring summary.`,
    summarizedCount,
  };
}
