import { extractGraph } from "../extract-graph";
import { formatConversationAsXml } from "../formatting";
import { ensureSourceNode } from "../ingestion/ensure-source-node";
import { ensureUser } from "../ingestion/ensure-user";
import { insertNewSources } from "../ingestion/insert-new-sources";
import { safeToISOString } from "../safe-date";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { type ConversationTurn } from "~/lib/conversation-store";
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";

export const MessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  role: z.string(),
  name: z.string().optional(),
  timestamp: z.string().datetime().pipe(z.coerce.date()),
});

type Message = z.infer<typeof MessageSchema>;

export const IngestConversationJobInputSchema = z.object({
  userId: z.string(),
  conversationId: z.string(),
  messages: z.array(MessageSchema),
});

export type IngestConversationJobInput = z.infer<
  typeof IngestConversationJobInputSchema
>;

interface IngestConversationParams extends IngestConversationJobInput {
  db: DrizzleDB;
}

/**
 * Ingest conversation by persisting only new turns
 * and extracting graph on them.
 * Returns `insertedTurns` (empty if none new).
 */
export async function ingestConversation({
  db,
  userId,
  conversationId,
  messages,
}: IngestConversationParams): Promise<{ insertedTurns: ConversationTurn[] }> {
  const { sourceNodeId, insertedTurns } = await initializeConversation(
    db,
    userId,
    conversationId,
    messages,
  );
  if (insertedTurns.length === 0) {
    return { insertedTurns };
  }
  // Safe: insertedTurns non-empty after guard
  const firstTurn = insertedTurns[0]!;
  const conversationNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId: sourceNodeId,
    timestamp: firstTurn.timestamp,
    nodeType: NodeTypeEnum.enum.Conversation,
  });
  await extractGraph({
    userId,
    sourceType: "conversation",
    linkedNodeId: conversationNodeId,
    content: formatConversationAsXml(insertedTurns),
  });
  return { insertedTurns };
}

/**
 * Initialize conversation ingestion:
 * - Ensure the user record exists
 * - Lookup the conversation source by external ID
 * - Map and persist only new message turns
 * @param db DrizzleDB instance
 * @param userId ID of the user
 * @param conversationId External conversation identifier
 * @param messages Array of incoming messages
 * @returns `sourceNodeId` (internal PK) and `insertedTurns` (only newly created turns)
 */
async function initializeConversation(
  db: DrizzleDB,
  userId: string,
  conversationId: string,
  messages: Message[],
): Promise<{
  sourceNodeId: TypeId<"source">;
  insertedTurns: ConversationTurn[];
}> {
  await ensureUser(db, userId);
  const { sourceNodeId, newSourceSourceIds } = await insertNewSources({
    db,
    userId,
    parentSourceType: "conversation",
    parentSourceId: conversationId,
    childSourceType: "conversation_message",
    childSources: messages.map((m) => ({
      externalId: m.id,
      timestamp: m.timestamp,
      content: m.content,
      metadata: {
        rawContent: m.content,
        role: m.role,
        name: m.name,
        timestamp: safeToISOString(m.timestamp),
      },
    })),
  });
  const insertedTurns = messages
    .filter((m) => newSourceSourceIds.includes(m.id))
    .map((m) => ({
      id: m.id,
      content: m.content,
      role: m.role,
      name: m.name,
      timestamp: m.timestamp,
    }));
  return { sourceNodeId, insertedTurns };
}
