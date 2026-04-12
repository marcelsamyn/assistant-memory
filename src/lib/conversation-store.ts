import { z } from "zod";
import { DrizzleDB } from "~/db";
import { TypeId } from "~/types/typeid";

// Schema to parse stored metadata for conversation messages
const recordMetadataSchema = z
  .object({
    rawContent: z.string(),
    role: z.string(),
    name: z.string().optional(),
    timestamp: z.string(),
  })
  .catchall(z.unknown());

/** A turn in a conversation, with external message identifier. */
export interface ConversationTurn {
  /** External message id from chat system */
  id: string;
  role: string;
  content: string;
  name: string | undefined;
  timestamp: Date;
}

/** Result of saving conversation turns: only newly inserted rows. */
export interface SaveConversationTurnsResult {
  /** Inserted rows info: internal PK and external id */
  successes: Array<{
    /** Internal Drizzle PK for the source row */
    internalId: TypeId<"source">;
    /** External message id */
    externalId: string;
  }>;
}

/**
 * Load and parse all conversation messages for a parent source.
 */
export async function loadConversationTurns(
  db: DrizzleDB,
  userId: string,
  parentSourceId: TypeId<"source">,
): Promise<ConversationTurn[]> {
  const rows = await db.query.sources.findMany({
    where: (src, { and, eq }) =>
      and(
        eq(src.userId, userId),
        eq(src.parentSource, parentSourceId),
        eq(src.type, "conversation_message"),
      ),
    orderBy: (src, { asc }) => asc(src.lastIngestedAt),
  });
  return rows.map((r) => {
    const meta = recordMetadataSchema.parse(r.metadata ?? {});
    return {
      id: r.externalId,
      role: meta.role,
      name: meta.name,
      content: meta.rawContent,
      timestamp: isNaN(new Date(meta.timestamp).getTime())
        ? new Date()
        : new Date(meta.timestamp),
    };
  });
}
