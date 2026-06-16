import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";

/** Prompt for a concise, specific source title. */
export function buildSourceTitlePrompt({
  type,
  contentPreview,
}: {
  type: string;
  contentPreview: string;
}): string {
  return `You are titling a source in a personal knowledge graph.

Source type: ${type}
Content preview:
"""
${contentPreview}
"""

Write a single, specific title (max ~60 characters) capturing what this is about. No quotes, no trailing punctuation, no generic filler like "Conversation about". Return only the title.`;
}

/**
 * Generate a title from a content preview using the cheap `source_title`
 * model. Returns a trimmed title (≤255 chars) or null when the model produced
 * nothing usable. The OpenAI client is resolved via `createCompletionClient`,
 * which returns the test override when one is set.
 */
export async function generateTitleFromContent({
  userId,
  type,
  contentPreview,
}: {
  userId: string;
  type: string;
  contentPreview: string;
}): Promise<string | null> {
  const { createCompletionClient, parseStructuredCompletion } = await import(
    "./ai"
  );
  const { modelForTask } = await import("../utils/models");
  const client = await createCompletionClient(userId, { task: "source_title" });
  const completion = await parseStructuredCompletion(
    client,
    {
      messages: [
        {
          role: "user",
          content: buildSourceTitlePrompt({ type, contentPreview }),
        },
      ],
      model: modelForTask("source_title"),
      max_tokens: 64,
      response_format: zodResponseFormat(
        z.object({ title: z.string() }),
        "source_title",
      ),
    },
    { task: "source_title", userId },
  );
  const title = completion.choices[0]?.message.parsed?.title?.trim();
  return title && title.length > 0 ? title.slice(0, 255) : null;
}
