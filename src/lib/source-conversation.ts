/**
 * Reassembles a conversation-shaped source (chat `conversation`,
 * `meeting_transcript`) from its `conversation_message` children. The parent
 * row stores no body of its own, so without this a transcript reads as empty.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import type { SourceConversation, SourceMessage } from "~/lib/schemas/sources";
import { typeIdSchema, type TypeId } from "~/types/typeid";

// Fields arrive as `metadata->>key` text, so absent keys are null.
const messageFieldsSchema = z.object({
  rawContent: z.string().nullable(),
  /** Transcript utterances. */
  speakerLabel: z.string().min(1).nullable().catch(null),
  speakerNodeId: typeIdSchema("node").nullable().catch(null),
  /** Chat turns. */
  role: z.string().min(1).nullable().catch(null),
  name: z.string().min(1).nullable().catch(null),
  timestamp: z.string().datetime().nullable().catch(null),
});

/** Transcript children use `${transcriptId}:${index}`. */
function utteranceIndex(externalId: string): number {
  const match = /:(\d+)$/.exec(externalId);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

const metadataText = (key: string) =>
  sql<string | null>`${sources.metadata}->>${key}`;

export async function loadSourceConversation(
  db: DrizzleDB,
  userId: string,
  source: { sourceId: TypeId<"source">; type: string },
): Promise<SourceConversation | null> {
  const ownedBy = eq(sources.userId, userId);
  const [rows, [parent]] = await Promise.all([
    db
      .select({
        id: sources.id,
        externalId: sources.externalId,
        createdAt: sources.createdAt,
        rawContent: metadataText("rawContent"),
        speakerLabel: metadataText("speakerLabel"),
        speakerNodeId: metadataText("speakerNodeId"),
        role: metadataText("role"),
        name: metadataText("name"),
        timestamp: metadataText("timestamp"),
      })
      .from(sources)
      .where(
        and(
          ownedBy,
          eq(sources.parentSource, source.sourceId),
          eq(sources.type, "conversation_message"),
          isNull(sources.deletedAt),
        ),
      ),
    db
      .select({ sourceKind: metadataText("sourceKind") })
      .from(sources)
      .where(and(ownedBy, eq(sources.id, source.sourceId)))
      .limit(1),
  ]);
  if (rows.length === 0) return null;

  return {
    sourceKind: parent?.sourceKind || null,
    messages: toConversationMessages(rows, {
      byUtteranceIndex: source.type === "meeting_transcript",
    }),
  };
}

interface MessageRow {
  id: TypeId<"source">;
  externalId: string;
  createdAt: Date;
  rawContent: string | null;
  speakerLabel: string | null;
  speakerNodeId: string | null;
  role: string | null;
  name: string | null;
  timestamp: string | null;
}

/**
 * Maps child rows to messages in conversation order. Transcript utterances
 * follow their index: untimed ones carry the meeting's start time as a
 * fallback, so their timestamps cannot order them. Chat turns follow time.
 */
export function toConversationMessages(
  rows: MessageRow[],
  { byUtteranceIndex }: { byUtteranceIndex: boolean },
): SourceMessage[] {
  const entries = rows.map((row) => {
    const fields = messageFieldsSchema.parse(row);
    const timestamp = fields.timestamp ? new Date(fields.timestamp) : null;
    const message: SourceMessage = {
      sourceId: row.id,
      speaker: fields.speakerLabel ?? fields.name ?? fields.role,
      speakerNodeId: fields.speakerNodeId,
      role: fields.role,
      timestamp,
      text: fields.rawContent ?? "",
    };
    return {
      message,
      at: (timestamp ?? row.createdAt).getTime(),
      index: byUtteranceIndex ? utteranceIndex(row.externalId) : 0,
      createdAt: row.createdAt.getTime(),
    };
  });
  entries.sort(
    (a, b) =>
      (byUtteranceIndex ? a.index - b.index : a.at - b.at) ||
      a.at - b.at ||
      a.createdAt - b.createdAt,
  );
  return entries.map((entry) => entry.message);
}
