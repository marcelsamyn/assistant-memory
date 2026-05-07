/**
 * Side-effect-free schema for the document-spine pre-pass: a small structured
 * LLM call that runs before chunked extraction to identify the document's
 * central thesis and 1-5 high-level "spine" concepts. The spine concepts are
 * pre-created as Concept nodes so per-chunk extractions can link low-level
 * entities (named programs, tools, recommendations) back to the document's
 * purpose via RELATED_TO claims — this is what wires "Kindle Unlimited" to
 * "Self-Publishing on Amazon" instead of leaving it as a free-floating fact.
 */
import { z } from "zod";

export const documentSpineSchema = z
  .object({
    thesis: z
      .string()
      .min(1)
      .describe(
        "One-sentence statement of the document's central thesis or purpose, in the author's voice (not the user's).",
      ),
    spineConcepts: z
      .array(
        z.object({
          label: z
            .string()
            .min(1)
            .describe(
              "Concise concept name (2-6 words). Examples: 'Self-Publishing on Amazon', 'Bestseller Marketing Strategy'. Use full phrasing, not abbreviations.",
            ),
          description: z
            .string()
            .min(1)
            .describe(
              "1-2 sentence description framing this as a central theme of the document.",
            ),
        }),
      )
      .min(1)
      .max(5)
      .describe(
        "The 1-5 highest-level concepts the entire document orbits around. Pick concepts at a level where most of the document's specific entities (named tools, programs, recommendations, decisions, people) would naturally connect to one of them. Avoid concepts that are too narrow ('KDP Select') or too broad ('publishing'). Avoid topics only mentioned in passing.",
      ),
  })
  .describe("document_spine");

export type DocumentSpine = z.infer<typeof documentSpineSchema>;
export type DocumentSpineConcept = DocumentSpine["spineConcepts"][number];
