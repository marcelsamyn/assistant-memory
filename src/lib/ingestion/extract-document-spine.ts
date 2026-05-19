/**
 * Pre-pass for document ingestion. Runs once before per-chunk graph
 * extraction and returns the document's central thesis plus 1-5 high-level
 * "spine" concepts. The chunked extractor then receives the spine concepts
 * as pre-existing nodes and is instructed to link low-level entities back to
 * them, so concrete details (named tools, programs, recommendations) end up
 * connected to the document's purpose instead of orphaned.
 *
 * Failure mode: if the LLM call throws or returns nothing the caller logs
 * and falls back to extraction-without-spine. The pre-pass is best-effort —
 * a missing spine should never break ingestion.
 */
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import {
  type DocumentSpine,
  documentSpineSchema,
} from "~/lib/schemas/document-spine";
import { env } from "~/utils/env";

// Cap how much markdown we send to the spine LLM. Most documents fit, but
// for very long inputs we keep the head + tail + a heading outline so the
// model still sees structural cues from the rest of the doc without paying
// for the full body twice (spine pass + per-chunk pass).
const SPINE_INPUT_HEAD_CHARS = 8_000;
const SPINE_INPUT_TAIL_CHARS = 4_000;
const SPINE_FULL_INPUT_LIMIT = 24_000;

export async function extractDocumentSpine(params: {
  userId: string;
  content: string;
}): Promise<DocumentSpine> {
  const { userId, content } = params;
  const condensed = condenseForSpine(content);

  const { createCompletionClient, parseStructuredCompletion } = await import(
    "~/lib/ai"
  );
  const client = await createCompletionClient(userId);

  const prompt = `You are reading a document to summarize its high-level shape for a graph extractor.

Identify two things and return them in the structured response:

1. The document's central thesis — one sentence stating what the document, taken as a whole, is about or argues.
2. The 1-5 highest-level concepts the document orbits around — the "spine". Pick concepts at a level where most of the document's specific entities (named tools, programs, methods, recommendations, named people, decisions) would naturally connect to one of them via a generic "related to" link.

Guidance:
- Spine concepts are themes, not specific entities. "Self-Publishing on Amazon" is a spine concept; "Kindle Direct Publishing" is a specific entity beneath it. "Building an Author Platform" is a spine concept; "Goodreads" is an entity beneath it.
- Pick concepts that span the document. If a topic only appears in one chapter, it is NOT a spine concept.
- Use full phrasing for labels, not abbreviations: "Self-Publishing on Amazon" rather than "Amazon SP".
- Speak in the author's frame, not the user's. The reader of this output is NOT the document's subject.

<document>
${condensed}
</document>`;

  const completion = await parseStructuredCompletion(client, {
    messages: [{ role: "user", content: prompt }],
    model: env.MODEL_ID_GRAPH_EXTRACTION,
    response_format: zodResponseFormat(documentSpineSchema, "document_spine"),
  });

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) throw new Error("Failed to parse document-spine response");
  return parsed;
}

/**
 * Trim the spine input for very long documents. Strategy: head + tail
 * preserves intro/conclusion (where thesis statements typically live) while
 * a flat list of all H1/H2 headings preserves coverage of the middle. This
 * lets the spine pass see "what the document is about" and "what sections
 * exist" without sending 100K characters.
 */
function condenseForSpine(content: string): string {
  if (content.length <= SPINE_FULL_INPUT_LIMIT) return content;

  const head = content.slice(0, SPINE_INPUT_HEAD_CHARS);
  const tail = content.slice(-SPINE_INPUT_TAIL_CHARS);
  const headings = extractHeadings(content);
  const headingBlock =
    headings.length > 0
      ? `\n\n[--- DOCUMENT HEADINGS (for structural context) ---]\n${headings.join("\n")}\n[--- END HEADINGS ---]\n\n`
      : "\n\n[--- middle of document elided for length ---]\n\n";

  return `${head}${headingBlock}${tail}`;
}

function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  for (const line of content.split("\n")) {
    if (/^#{1,2}\s/.test(line)) headings.push(line.trim());
  }
  return headings;
}
