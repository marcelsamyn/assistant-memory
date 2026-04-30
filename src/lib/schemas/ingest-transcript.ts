/**
 * Request/response schemas for `POST /transcript/ingest` (Phase 4 PR 4ii-b).
 *
 * The route accepts either raw transcript text (segmented server-side via the
 * LLM) or a pre-segmented array of utterances. `userSelfAliasesOverride`
 * replaces stored aliases for this ingestion only — useful for ad-hoc
 * transcripts where the user appears under a different label than usual.
 * Stored aliases are never mutated.
 */
import { z } from "zod";
import { ScopeEnum } from "~/types/graph";
import { typeIdSchema } from "~/types/typeid";

export const transcriptUtteranceSchema = z.object({
  speakerLabel: z.string().min(1),
  content: z.string().min(1),
  timestamp: z.string().datetime().optional(),
});

export const transcriptContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("raw"),
    text: z.string().min(1).max(500_000),
  }),
  z.object({
    kind: z.literal("segmented"),
    utterances: z.array(transcriptUtteranceSchema).min(1),
  }),
]);

export const transcriptKnownParticipantSchema = z.object({
  label: z.string().min(1),
  nodeId: typeIdSchema("node"),
});

export const ingestTranscriptRequestSchema = z.object({
  userId: z.string().min(1),
  transcriptId: z.string().min(1),
  scope: ScopeEnum.optional().default("personal"),
  occurredAt: z.string().datetime(),
  content: transcriptContentSchema,
  knownParticipants: z.array(transcriptKnownParticipantSchema).optional(),
  /** Replaces stored `userSelfAliases` for this ingestion only; the stored list is not mutated. */
  userSelfAliasesOverride: z.array(z.string().min(1)).optional(),
});

export const ingestTranscriptResponseSchema = z.object({
  message: z.string(),
  jobId: z.string(),
});

export type IngestTranscriptRequest = z.infer<
  typeof ingestTranscriptRequestSchema
>;
export type IngestTranscriptResponse = z.infer<
  typeof ingestTranscriptResponseSchema
>;
export type TranscriptUtterance = z.infer<typeof transcriptUtteranceSchema>;
export type TranscriptContent = z.infer<typeof transcriptContentSchema>;
export type TranscriptKnownParticipant = z.infer<
  typeof transcriptKnownParticipantSchema
>;
