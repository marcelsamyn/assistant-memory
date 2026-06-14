import { createCompletionClient, parseStructuredCompletion } from "./ai";
import { commitmentPresentationLlmSchema } from "./schemas/commitment-presentation";
import { locateVerbatim } from "./verbatim";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import type { DrizzleDB } from "~/db";
import { commitmentPresentations } from "~/db/schema";
import type { TypeId } from "~/types/typeid";
import { MODEL_MAX_OUTPUT_TOKENS, modelForTask } from "~/utils/models";

export { commitmentPresentationLlmSchema } from "./schemas/commitment-presentation";

const WHY_MAX_CHARS = 140;

const SYSTEM_PROMPT =
  "You extract honest evidence for a task the assistant inferred from a user's messages. " +
  "The excerpt MUST be an exact, verbatim substring of the provided source — copy it character-for-character, or return null. " +
  "Never fabricate, paraphrase, or stitch together a quote. The 'why' is a single short second-person line grounded in the source.";

/**
 * Produce honest presentation evidence for a freshly-inferred commitment.
 * Fail-soft: any error yields `{ excerpt: null, why: null }` — this MUST NOT
 * throw into ingestion. The excerpt is validated against the real source in
 * code (`locateVerbatim`), so the model cannot fabricate a quote.
 */
export async function generateCommitmentPresentation(args: {
  userId: string;
  content: string;
  taskLabel: string;
}): Promise<{ excerpt: string | null; why: string | null }> {
  try {
    // Mirror extractGraph's LLM seam (createCompletionClient +
    // parseStructuredCompletion) rather than performStructuredAnalysis, so the
    // extraction tests' `createCompletionClient` mock also covers this call —
    // otherwise the pass fires a real network request inside those tests.
    const client = await createCompletionClient(args.userId, {
      task: "commitment_presentation",
    });
    const completion = await parseStructuredCompletion(
      client,
      {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Task the assistant inferred: "${args.taskLabel}"\n\nSource text:\n"""\n${args.content}\n"""`,
          },
        ],
        model: modelForTask("commitment_presentation"),
        max_tokens: MODEL_MAX_OUTPUT_TOKENS,
        response_format: zodResponseFormat(
          commitmentPresentationLlmSchema,
          "commitment_presentation",
        ),
      },
      { task: "commitment_presentation", userId: args.userId },
    );
    const out = completion.choices[0]?.message.parsed;
    const excerpt = locateVerbatim(args.content, out?.excerpt ?? null);
    const why = out?.why?.trim().slice(0, WHY_MAX_CHARS) || null;
    return { excerpt, why };
  } catch (error) {
    console.warn(`commitment presentation generation failed: ${String(error)}`);
    return { excerpt: null, why: null };
  }
}

/** Upsert presentation evidence for a task (idempotent on re-extraction). */
export async function upsertCommitmentPresentation(
  db: DrizzleDB,
  row: {
    taskId: TypeId<"node">;
    userId: string;
    sourceId: TypeId<"source">;
    excerpt: string | null;
    why: string | null;
  },
): Promise<void> {
  await db
    .insert(commitmentPresentations)
    .values(row)
    .onConflictDoUpdate({
      target: commitmentPresentations.taskId,
      set: { excerpt: row.excerpt, why: row.why, sourceId: row.sourceId },
    });
}
