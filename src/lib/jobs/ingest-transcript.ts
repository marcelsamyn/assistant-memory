/**
 * Multi-party transcript ingestion (Phase 4 PR 4ii-b).
 *
 * Pipeline:
 *   1. If raw, segment via the LLM (`segmentTranscript`); pre-segmented input
 *      passes through.
 *   2. Resolve speakers (user-self → knownParticipants → alias system →
 *      placeholder Person).
 *   3. Insert a parent `meeting_transcript` source plus per-utterance
 *      `conversation_message` child sources, each carrying speaker
 *      provenance metadata (`speakerLabel`, `speakerNodeId`).
 *   4. Run `extractGraph` with the speaker map injected, so claims attributed
 *      to the user-self collapse to `assertedByKind = 'user'` and others to
 *      `participant` with `assertedByNodeId` set.
 *
 * Common aliases: transcript ingestion, meeting transcript pipeline, speaker
 * provenance, multi-party conversation.
 */
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { extractGraph } from "~/lib/extract-graph";
import { ensureSourceNode } from "~/lib/ingestion/ensure-source-node";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { insertNewSources } from "~/lib/ingestion/insert-new-sources";
import { logEvent } from "~/lib/observability/log";
import { safeToISOString } from "~/lib/safe-date";
import {
  defaultSegmentTranscriptClient,
  type SegmentedUtterance,
  type SegmentTranscriptClient,
} from "~/lib/transcript/segment-transcript";
import {
  resolveSpeakers,
  type ResolvedSpeaker,
  type SpeakerMap,
} from "~/lib/transcript/resolve-speakers";
import { getUserSelfAliases } from "~/lib/user-profile";
import { NodeTypeEnum, ScopeEnum } from "~/types/graph";
import { typeIdSchema, type TypeId } from "~/types/typeid";

const utteranceJobSchema = z.object({
  speakerLabel: z.string().min(1),
  content: z.string().min(1),
  timestamp: z.string().datetime().optional(),
});

const knownParticipantJobSchema = z.object({
  label: z.string().min(1),
  nodeId: typeIdSchema("node"),
});

const transcriptContentJobSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("raw"), text: z.string().min(1) }),
  z.object({
    kind: z.literal("segmented"),
    utterances: z.array(utteranceJobSchema).min(1),
  }),
]);

export const IngestTranscriptJobInputSchema = z.object({
  userId: z.string().min(1),
  transcriptId: z.string().min(1),
  scope: ScopeEnum.optional().default("personal"),
  occurredAt: z.string().datetime().pipe(z.coerce.date()),
  content: transcriptContentJobSchema,
  knownParticipants: z.array(knownParticipantJobSchema).optional(),
  userSelfAliasesOverride: z.array(z.string().min(1)).optional(),
});

export type IngestTranscriptJobInput = z.infer<
  typeof IngestTranscriptJobInputSchema
>;

export interface IngestTranscriptResult {
  transcriptSourceId: TypeId<"source">;
  utteranceCount: number;
  resolvedSpeakers: number;
  unresolvedSpeakers: number;
}

export interface IngestTranscriptParams extends IngestTranscriptJobInput {
  db: DrizzleDB;
  /** Test seam — defaults to the LLM-backed segmenter. */
  segmenter?: SegmentTranscriptClient;
}

export async function ingestTranscript(
  params: IngestTranscriptParams,
): Promise<IngestTranscriptResult> {
  const {
    db,
    userId,
    transcriptId,
    scope,
    occurredAt,
    content,
    knownParticipants,
    userSelfAliasesOverride,
    segmenter = defaultSegmentTranscriptClient,
  } = params;

  await ensureUser(db, userId);

  const utterances = await loadUtterances({
    userId,
    occurredAt,
    content,
    segmenter,
  });
  if (utterances.length === 0) {
    throw new Error("Transcript ingestion produced zero utterances");
  }

  const userSelfAliases =
    userSelfAliasesOverride ?? (await getUserSelfAliases(db, userId));

  const speakerLabels = utterances.map((u) => u.speakerLabel);
  const speakerMap = await resolveSpeakers({
    db,
    userId,
    speakerLabels,
    userSelfAliases,
    ...(knownParticipants !== undefined ? { knownParticipants } : {}),
  });

  const childSources = utterances.map((utterance, index) => {
    const speaker = lookupSpeaker(speakerMap, utterance.speakerLabel);
    const utteranceTimestamp = utterance.timestamp ?? occurredAt;
    return {
      externalId: `${transcriptId}:${index}`,
      timestamp: utteranceTimestamp,
      content: utterance.content,
      metadata: {
        rawContent: utterance.content,
        speakerLabel: utterance.speakerLabel,
        ...(speaker !== undefined ? { speakerNodeId: speaker.nodeId } : {}),
        timestamp: safeToISOString(utteranceTimestamp),
      },
    };
  });

  const { sourceId: transcriptSourceId, sourceRefs } = await insertNewSources({
    db,
    userId,
    parentSourceType: "meeting_transcript",
    parentSourceId: transcriptId,
    childSourceType: "conversation_message",
    scope,
    childSources,
  });

  const transcriptNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId: transcriptSourceId,
    timestamp: occurredAt,
    nodeType: NodeTypeEnum.enum.Conversation,
  });

  const externalIdsByIndex = new Map<number, string>();
  for (const ref of sourceRefs) {
    // externalId format: `${transcriptId}:${index}`
    const suffix = ref.externalId.slice(transcriptId.length + 1);
    const index = Number(suffix);
    if (!Number.isNaN(index)) externalIdsByIndex.set(index, ref.externalId);
  }
  const formattedContent = formatTranscriptForExtraction(
    utterances,
    externalIdsByIndex,
    transcriptId,
  );

  // Build the extractGraph speaker map (raw label → nodeId + isUserSelf).
  const extractionSpeakerMap = new Map<
    string,
    { nodeId: TypeId<"node">; isUserSelf: boolean }
  >();
  for (const [label, entry] of speakerMap.entries()) {
    extractionSpeakerMap.set(label, {
      nodeId: entry.nodeId,
      isUserSelf: entry.isUserSelf,
    });
  }

  if (sourceRefs.length > 0) {
    await extractGraph({
      userId,
      sourceType: "meeting_transcript",
      sourceId: transcriptSourceId,
      statedAt: occurredAt,
      linkedNodeId: transcriptNodeId,
      sourceRefs,
      content: formattedContent,
      speakerMap: extractionSpeakerMap,
    });
  }

  let unresolvedCount = 0;
  for (const entry of speakerMap.values()) {
    if (entry.resolution === "placeholder") unresolvedCount += 1;
  }
  const resolvedSpeakers = speakerMap.size - unresolvedCount;

  logEvent("transcript.ingested", {
    userId,
    transcriptId,
    transcriptSourceId,
    utteranceCount: utterances.length,
    resolvedSpeakers,
    unresolvedSpeakers: unresolvedCount,
    scope,
  });

  return {
    transcriptSourceId,
    utteranceCount: utterances.length,
    resolvedSpeakers,
    unresolvedSpeakers: unresolvedCount,
  };
}

async function loadUtterances({
  userId,
  occurredAt,
  content,
  segmenter,
}: {
  userId: string;
  occurredAt: Date;
  content: IngestTranscriptJobInput["content"];
  segmenter: SegmentTranscriptClient;
}): Promise<SegmentedUtterance[]> {
  if (content.kind === "segmented") {
    return content.utterances.map((u) => ({
      speakerLabel: u.speakerLabel,
      content: u.content,
      ...(u.timestamp ? { timestamp: new Date(u.timestamp) } : {}),
    }));
  }
  return segmenter.segment({
    userId,
    rawContent: content.text,
    occurredAt,
  });
}

/**
 * Render utterances as XML for the extractor. Each `<utterance id="…">` uses
 * the same external sourceRef the extractor is told to cite, so the
 * extractor's standard sourceRef-token validation works without changes.
 */
function formatTranscriptForExtraction(
  utterances: SegmentedUtterance[],
  externalIdsByIndex: Map<number, string>,
  transcriptId: string,
): string {
  return utterances
    .map((utterance, index) => {
      const externalId =
        externalIdsByIndex.get(index) ?? `${transcriptId}:${index}`;
      const escaped = escapeXml(utterance.content);
      const speaker = escapeXml(utterance.speakerLabel);
      return `<utterance id="${escapeXml(externalId)}" speaker="${speaker}">${escaped}</utterance>`;
    })
    .join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function lookupSpeaker(
  speakerMap: SpeakerMap,
  label: string,
): ResolvedSpeaker | undefined {
  const direct = speakerMap.get(label);
  if (direct) return direct;
  const target = label.toLowerCase();
  for (const [key, value] of speakerMap.entries()) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}
