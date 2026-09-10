import { typeIdSchema } from "../../types/typeid.js";
import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

/** An application-owned participant. The message body never enters this contract. */
export const sourceParticipantSchema = z
  .object({
    email: z.string().email().max(320),
    name: z.string().min(1).max(200).optional(),
  })
  .strict();

export const sourceReferenceSchema = z
  .object({
    sourceId: typeIdSchema("source"),
    relationship: z.string().min(1).max(80),
  })
  .strict();

/**
 * Versioned, application-owned facts that explain a source to Memory.
 *
 * This schema deliberately contains no source text, instructions, or
 * permissions. Email content and attachment text remain untrusted evidence.
 */
export const sourceContextSchema = z
  .object({
    version: z.literal(1).optional().default(1),
    sourceKind: z.enum(["email", "email_attachment", "document", "file"]),
    /** Why the caller supplied this source, in application-owned wording. */
    purpose: z.string().min(1).max(500),
    accountId: z.string().min(1).max(200),
    /** Relationship of the authenticated account to the source participants. */
    relationship: z.string().min(1).max(80),
    sender: sourceParticipantSchema.optional(),
    recipients: z.array(sourceParticipantSchema).max(100).optional(),
    direction: z.enum(["incoming", "outgoing"]).optional(),
    messageId: z.string().min(1).max(500).optional(),
    threadId: z.string().min(1).max(500).optional(),
    /** Canonical provider or application URL, never fetched by Memory. */
    sourceUrl: z.string().url().max(2_000).optional(),
    authoredAt: z.string().datetime().optional(),
    /** Chronology is a small application-owned summary, not quoted mail. */
    chronology: z
      .object({
        receivedAt: z.string().datetime().optional(),
        previousMessageId: z.string().min(1).max(500).optional(),
        isLatestInThread: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Role of this source in the current message or attachment set. */
    currentMessageRole: z.enum([
      "current",
      "current_message",
      "primary",
      "request",
      "reply",
      "response",
      "context",
      "attachment",
      "quoted_history",
      "unknown",
    ]),
    /** Containment parent. The request partition authorizes this reference. */
    parentSourceId: typeIdSchema("source").optional(),
    /** Accepted for compatibility; server code never uses it as an authority. */
    parentPartitionKey: contextPartitionKeySchema.optional(),
    sourceReferences: z.array(sourceReferenceSchema).max(100).optional(),
    completeness: z.enum(["complete", "partial", "unknown"]),
  })
  .strict();

export type SourceContext = z.infer<typeof sourceContextSchema>;
export type SourceParticipant = z.infer<typeof sourceParticipantSchema>;
export type SourceContextParent = Pick<
  SourceContext,
  "parentSourceId" | "parentPartitionKey"
> & { parentSourceId: NonNullable<SourceContext["parentSourceId"]> };
