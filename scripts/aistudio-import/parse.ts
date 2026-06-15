/**
 * Pure parsing + shaping logic for the Google AI Studio → Assistant Memory
 * importer. No network, fs, or env access — every function here is pure so it
 * can be unit-tested without a Memory backend.
 *
 * An AI Studio export stores the whole conversation under
 * `chunkedPrompt.chunks`. Three kinds of chunk must be excluded before
 * ingestion:
 *   - Large pasted attachments (a dossier, a book) surface as `driveDocument`
 *     pointers with NO inline `text` — their content isn't even in the file.
 *   - The model's internal reasoning surfaces as separate `isThought` chunks.
 *   - Errored generations carry an `errorMessage` and no text.
 * The single robust rule that drops all three: keep a chunk only if it has
 * non-blank inline text and is not a thought.
 *
 * Common aliases: aistudio import parse, gemini export filter, transcript turns.
 */
import { z } from "zod";

const chunkSchema = z.object({
  role: z.enum(["user", "model"]),
  text: z.string().optional(),
  createTime: z.string().optional(),
  isThought: z.boolean().optional(),
  errorMessage: z.string().optional(),
});

export const aiStudioExportSchema = z.object({
  chunkedPrompt: z.object({
    chunks: z.array(chunkSchema),
  }),
});

export type AiStudioExport = z.infer<typeof aiStudioExportSchema>;

/** A real, ingestable conversation turn after exclusions are applied. */
export type ConversationTurn = {
  role: "user" | "model";
  text: string;
  createTime?: string;
};

/** A speaker-attributed utterance for the Memory transcript endpoint. */
export type Utterance = {
  speakerLabel: string;
  content: string;
  timestamp?: string;
};

/** Validate raw JSON at the boundary; unknown chunk keys are stripped. */
export function parseExport(raw: unknown): AiStudioExport {
  return aiStudioExportSchema.parse(raw);
}

/**
 * Keep only the genuine dialogue turns: non-blank inline text, excluding the
 * model's `isThought` reasoning. Drive-attachment and errored chunks have no
 * text and fall away naturally.
 */
export function extractConversationTurns(
  parsed: AiStudioExport,
): ConversationTurn[] {
  return parsed.chunkedPrompt.chunks.flatMap((chunk) =>
    chunk.isThought || !chunk.text || chunk.text.trim().length === 0
      ? []
      : [
          {
            role: chunk.role,
            text: chunk.text,
            ...(chunk.createTime ? { createTime: chunk.createTime } : {}),
          },
        ],
  );
}

/** Map turns to speaker-attributed utterances (user → self, model → coach). */
export function toUtterances(
  turns: ConversationTurn[],
  labels: { selfLabel: string; coachLabel: string },
): Utterance[] {
  return turns.map((turn) => ({
    speakerLabel: turn.role === "user" ? labels.selfLabel : labels.coachLabel,
    content: turn.text,
    ...(turn.createTime ? { timestamp: turn.createTime } : {}),
  }));
}

/**
 * Turns strictly newer than `watermark` (an ISO createTime). With no watermark,
 * every turn is returned. A watermark excludes turns that lack a createTime,
 * since they can't be proven new — guarding against re-ingestion.
 */
export function turnsAfter(
  turns: ConversationTurn[],
  watermark: string | undefined,
): ConversationTurn[] {
  if (!watermark) return turns;
  return turns.filter((turn) => turn.createTime && turn.createTime > watermark);
}

/** Split into ordered groups of at most `size`, preserving order. */
export function chunkIntoBatches<T>(items: T[], size: number): T[][] {
  if (size < 1) throw new Error(`batch size must be >= 1, got ${size}`);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/** The maximum createTime across turns, for advancing the watermark. */
export function latestTimestamp(turns: ConversationTurn[]): string | undefined {
  return turns.reduce<string | undefined>(
    (max, turn) =>
      turn.createTime && (!max || turn.createTime > max)
        ? turn.createTime
        : max,
    undefined,
  );
}

/** Lowercase, dash-separated slug for deriving a stable transcript-id prefix. */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "aistudio"
  );
}
