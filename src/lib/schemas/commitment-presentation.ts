/**
 * Side-effect-free schema for the commitment-presentation pass: a small
 * structured LLM call that extracts a verbatim excerpt and a short "why"
 * for each newly-inferred Task node.
 *
 * Common aliases: presentation schema, commitment excerpt, commitment why.
 */
import { z } from "zod";

/** Structured output for the presentation pass (OpenAI-safe: all keys required, nullable not optional). */
export const commitmentPresentationLlmSchema = z
  .object({
    excerpt: z
      .string()
      .nullable()
      .describe(
        "A SHORT exact quote, copied character-for-character from the provided source text, that directly evidences this commitment. If no single span cleanly evidences it, return null. Never paraphrase, summarize, or invent.",
      ),
    why: z
      .string()
      .nullable()
      .describe(
        "One short second-person line (max ~15 words) explaining why this is a commitment, grounded in the source. e.g. 'You set a concrete launch window.' Null if nothing meaningful to add.",
      ),
  })
  .describe("commitment_presentation");

export type CommitmentPresentationLlmOutput = z.infer<
  typeof commitmentPresentationLlmSchema
>;
