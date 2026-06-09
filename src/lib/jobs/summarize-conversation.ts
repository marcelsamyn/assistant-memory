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
import { MODEL_MAX_OUTPUT_TOKENS, modelForTask } from "~/utils/models";

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
 * Strategy for handling a {@link MalformedUpstreamCompletionError} on an
 * individual source. Different callers want different behavior because
 * they're in different positions to recover:
 *
 * - `"retry-job"`: rethrow so a BullMQ worker can retry the whole job.
 *   Used by the standalone summarize worker on non-final attempts so
 *   `attempts: N` exponential backoff handles transient upstream blips.
 * - `"mark-failed"`: flip the source to `status: "failed"` and continue
 *   processing the rest. Used on the final summarize retry to break out
 *   of the retry loop when a specific source consistently trips the
 *   upstream parser bug.
 * - `"skip"`: leave the source untouched and continue. Used by the dream
 *   worker so one bad source doesn't halt the entire dream cycle; the
 *   source is picked up by the next standalone summarize batch.
 */
export type MalformedUpstreamStrategy = "retry-job" | "mark-failed" | "skip";

export interface SummarizeUserConversationsOptions {
  /** See {@link MalformedUpstreamStrategy}. Defaults to `"retry-job"`. */
  onMalformedUpstream?: MalformedUpstreamStrategy;
}

/**
 * Summarizes conversations for a given user.
 * Fetches conversations needing summarization, calls OpenAI, and updates metadata.
 */
export async function summarizeUserConversations(
  db: DrizzleDB,
  userId: string,
  opts: SummarizeUserConversationsOptions = {},
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
  const {
    createCompletionClient,
    MalformedUpstreamCompletionError,
    parseStructuredCompletion,
  } = await import("../ai");
  const client = await createCompletionClient(userId, {
    task: "conversation_summary",
  });

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
      const completion = await parseStructuredCompletion(
        client,
        {
          messages: [{ role: "user", content: prompt }],
          model: modelForTask("conversation_summary"),
          max_tokens: MODEL_MAX_OUTPUT_TOKENS,
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
        },
        { task: "conversation_summary", userId },
      );

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
      if (error instanceof MalformedUpstreamCompletionError) {
        const strategy = opts.onMalformedUpstream ?? "retry-job";
        if (strategy === "retry-job") {
          // Earlier sources in this loop are already marked
          // `summarized` and get filtered out on the next pass, so a
          // job retry resumes from the failing source.
          throw error;
        }
        if (strategy === "mark-failed") {
          console.error(
            `Summarize - upstream returned malformed completion for source ${sourceId} on final attempt; marking failed`,
          );
          await db
            .update(sources)
            .set({ status: "failed" })
            .where(eq(sources.id, sourceId));
          continue;
        }
        // "skip": leave the source untouched for the next batch.
        console.warn(
          `Summarize - upstream returned malformed completion for source ${sourceId}; skipping (will retry on next batch)`,
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
