/**
 * Contract for the lossless lifecycle feed (`POST /query/change-feed`).
 *
 * This is intentionally separate from `queryRecentChanges`: the latter is a
 * capped display read model, while this contract is a replayable keyset feed
 * for projections. Cursors carry the feed epoch, last sequence, partition,
 * and the first page's frozen `throughSequence` watermark.
 */
import { contextPartitionKeySchema } from "./partition.js";
import { z } from "zod";

export const CHANGE_FEED_SCHEMA_EPOCH = 1 as const;

export const changeFeedEventKindEnum = z.enum([
  "source",
  "ingestion",
  "claim",
  "commitment",
  "node",
  "provenance",
  "redirect",
  "deletion",
  "freshness",
  "status",
]);
export type ChangeFeedEventKind = z.infer<typeof changeFeedEventKindEnum>;

export const changeFeedCursorSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  partitionKey: contextPartitionKeySchema.nullable(),
  feedEpoch: z.number().int().positive(),
  sequence: z.number().int().nonnegative(),
  throughSequence: z.number().int().nonnegative(),
});
export type ChangeFeedCursor = z.infer<typeof changeFeedCursorSchema>;

export const changeFeedCursorInvalidReasonEnum = z.enum([
  "malformed",
  "user_mismatch",
  "partition_mismatch",
  "epoch_mismatch",
  "sequence_unavailable",
]);
export type ChangeFeedCursorInvalidReason = z.infer<
  typeof changeFeedCursorInvalidReasonEnum
>;

export const changeFeedCursorInvalidSchema = z.object({
  reason: changeFeedCursorInvalidReasonEnum,
  message: z.string().min(1),
  requestedFeedEpoch: z.number().int().positive().nullable(),
  currentFeedEpoch: z.number().int().positive(),
  throughSequence: z.number().int().nonnegative(),
});
export type ChangeFeedCursorInvalid = z.infer<
  typeof changeFeedCursorInvalidSchema
>;

const isoDateTimeSchema = z.coerce.date();

/**
 * One immutable lifecycle transition in sequence order. Tombstones are
 * identified by `action === "tombstone"` plus `entityType`. Current producers
 * Ordinary source/claim/commitment deletes retain their entity-family kind;
 * partition retractions and cascade-owned rows use `kind: "deletion"`.
 * Consumers must not branch on `kind` alone because lifecycle producers may
 * carry a tombstone action under their own entity-family kind.
 */
export const changeFeedEventSchema = z.object({
  eventId: z.string().min(1),
  userId: z.string().min(1),
  partitionKey: contextPartitionKeySchema.nullable(),
  feedEpoch: z.number().int().positive(),
  sequence: z.number().int().positive(),
  kind: changeFeedEventKindEnum,
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().nullable(),
  sourceId: z.string().nullable(),
  effectiveChangeTime: isoDateTimeSchema,
  /** Source/claim/node provenance supplied by the memory authority. */
  provenance: z.record(z.string(), z.unknown()).nullable(),
  /** Coverage and ingestion freshness; null when not applicable. */
  freshness: z.record(z.string(), z.unknown()).nullable(),
  status: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  tieBreaker: z.string().min(1),
});
export type ChangeFeedEvent = z.infer<typeof changeFeedEventSchema>;

export const queryChangeFeedRequestSchema = z
  .object({
    userId: z.string().min(1),
    partitionKey: contextPartitionKeySchema.optional(),
    /** Opaque keyset cursor returned by the previous page. */
    cursor: z.string().min(1).max(2048).optional(),
    /** First sweep only. Omission replays from the beginning. */
    startAt: z.enum(["beginning", "head"]).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  })
  .refine(
    (input) => input.cursor === undefined || input.startAt === undefined,
    {
      message: "Specify either cursor or startAt, not both.",
      path: ["startAt"],
    },
  );
export type QueryChangeFeedRequest = z.input<
  typeof queryChangeFeedRequestSchema
>;

export const queryChangeFeedResponseSchema = z.object({
  feedSchemaEpoch: z.literal(CHANGE_FEED_SCHEMA_EPOCH),
  feedEpoch: z.number().int().positive(),
  partitionKey: contextPartitionKeySchema.nullable(),
  /** First page freezes this watermark; every continuation retains it. */
  throughSequence: z.number().int().nonnegative(),
  events: z.array(changeFeedEventSchema),
  nextCursor: z.string().nullable(),
  /** Resume after a completed sweep. Absent on servers without tail polling. */
  checkpointCursor: z.string().nullable().optional(),
  /** True when all events through `throughSequence` have been returned. */
  complete: z.boolean(),
  /** Alias retained for consumers that call the page boundary `pageComplete`. */
  pageComplete: z.boolean(),
  cursorInvalid: changeFeedCursorInvalidSchema.optional(),
});
export type QueryChangeFeedResponse = z.infer<
  typeof queryChangeFeedResponseSchema
>;
