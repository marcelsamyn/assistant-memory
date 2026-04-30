/**
 * LLM-driven transcript segmentation.
 *
 * Given a raw multi-party transcript string, return the ordered list of
 * speaker turns. Each utterance is one continuous turn by one speaker; the
 * model preserves whatever speaker labels appear in the source (e.g.
 * "Alice", "Marcel", "Speaker 2") without canonicalizing.
 *
 * Common aliases: transcript segmentation, speaker turn detection,
 * utterance extraction, multi-party transcript ingestion.
 */
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import { z } from "zod";
import { createCompletionClient } from "~/lib/ai";
import { env } from "~/utils/env";

export const segmentedUtteranceSchema = z.object({
  speakerLabel: z
    .string()
    .min(1)
    .describe("Speaker label as it appears in the transcript."),
  content: z.string().min(1).describe("The full text of the speaker's turn."),
  timestamp: z
    .string()
    .datetime()
    .optional()
    .describe("Optional ISO timestamp for the utterance, if known."),
});

export type SegmentedUtteranceInput = z.infer<typeof segmentedUtteranceSchema>;

const segmentationResponseSchema = z
  .object({
    utterances: z.array(segmentedUtteranceSchema),
  })
  .describe("transcript_segmentation");

export interface SegmentedUtterance {
  speakerLabel: string;
  content: string;
  timestamp?: Date;
}

export interface SegmentTranscriptInput {
  userId: string;
  rawContent: string;
  occurredAt: Date;
}

export interface SegmentTranscriptClient {
  segment(input: SegmentTranscriptInput): Promise<SegmentedUtterance[]>;
}

const SYSTEM_PROMPT = `You segment raw meeting/chat transcripts into speaker turns.

Rules:
- Each utterance is one continuous turn by one speaker. Do NOT split a single turn into multiple utterances.
- Preserve speaker labels EXACTLY as they appear in the transcript (e.g. "Alice", "Marcel", "Dr. Chen").
- If the transcript has no clear speaker labels, fall back to "Speaker 1", "Speaker 2", etc., assigning the same label to the same voice consistently.
- Do not summarize, paraphrase, or re-order utterances. Return the original wording verbatim, only stripping the speaker prefix.
- Do not invent speakers. Every utterance must be attributable to one labeled speaker.`;

/**
 * Default segmentation client — calls the configured graph-extraction model
 * via `createCompletionClient`. Tests can pass a stub `SegmentTranscriptClient`
 * to the ingestion pipeline instead of mocking the OpenAI module.
 */
export const defaultSegmentTranscriptClient: SegmentTranscriptClient = {
  async segment({
    userId,
    rawContent,
    occurredAt,
  }: SegmentTranscriptInput): Promise<SegmentedUtterance[]> {
    const client = await createCompletionClient(userId);
    const prompt = `Segment the following transcript by speaker turn.

The transcript was recorded around ${occurredAt.toISOString()}. If individual utterance timestamps are visible, include them as ISO 8601; otherwise omit the timestamp field.

<transcript>
${rawContent}
</transcript>`;

    const completion = await client.beta.chat.completions.parse({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      model: env.MODEL_ID_GRAPH_EXTRACTION,
      response_format: zodResponseFormat(
        segmentationResponseSchema,
        "transcript_segmentation",
      ),
    });

    const parsed = completion.choices[0]?.message.parsed;
    if (!parsed) {
      throw new Error("Failed to parse transcript segmentation response");
    }
    if (parsed.utterances.length === 0) {
      throw new Error(
        "Transcript segmentation returned zero utterances; refusing to ingest empty transcript",
      );
    }
    return parsed.utterances.map((utterance) => ({
      speakerLabel: utterance.speakerLabel,
      content: utterance.content,
      ...(utterance.timestamp
        ? { timestamp: new Date(utterance.timestamp) }
        : {}),
    }));
  },
};
