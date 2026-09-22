import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import {
  memoryChangeFeedEvents,
  memoryChangeFeedHeads,
  sources,
} from "~/db/schema";
import { assertPartitionReadAllowed } from "~/lib/partition-access";
import {
  contextPartitionKeySchema,
  type ContextPartitionKey,
} from "~/lib/schemas/partition";
import {
  CHANGE_FEED_SCHEMA_EPOCH,
  changeFeedCursorSchema,
  changeFeedEventSchema,
  type ChangeFeedCursor,
  type QueryChangeFeedRequest,
  type QueryChangeFeedResponse,
} from "~/lib/schemas/query-change-feed";
import { useDatabase } from "~/utils/db";

const recordSchema = z.record(z.string(), z.unknown());

function partitionFilter(partitionKey: ContextPartitionKey | undefined) {
  return partitionKey === undefined
    ? isNull(memoryChangeFeedEvents.partitionKey)
    : eq(memoryChangeFeedEvents.partitionKey, partitionKey);
}

function headPartitionFilter(partitionKey: ContextPartitionKey | undefined) {
  return partitionKey === undefined
    ? isNull(memoryChangeFeedHeads.partitionKey)
    : eq(memoryChangeFeedHeads.partitionKey, partitionKey);
}

function encodeCursor(cursor: ChangeFeedCursor): string {
  return `v1.${encodeURIComponent(JSON.stringify(cursor))}`;
}

function decodeCursor(value: string): ChangeFeedCursor | null {
  if (!value.startsWith("v1.")) return null;
  try {
    return changeFeedCursorSchema.parse(
      JSON.parse(decodeURIComponent(value.slice(3))),
    );
  } catch {
    return null;
  }
}

function nullableRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  return recordSchema.parse(value ?? {});
}

function invalidCursor(
  reason: NonNullable<QueryChangeFeedResponse["cursorInvalid"]>["reason"],
  message: string,
  currentFeedEpoch: number,
  throughSequence: number,
  requestedFeedEpoch: number | null,
  partitionKey: ContextPartitionKey | undefined,
): QueryChangeFeedResponse {
  return {
    feedSchemaEpoch: CHANGE_FEED_SCHEMA_EPOCH,
    feedEpoch: currentFeedEpoch,
    partitionKey: partitionKey ?? null,
    throughSequence,
    events: [],
    nextCursor: null,
    checkpointCursor: null,
    complete: false,
    pageComplete: false,
    cursorInvalid: {
      reason,
      message,
      requestedFeedEpoch,
      currentFeedEpoch,
      throughSequence,
    },
  };
}

/**
 * Read the append-only lifecycle feed in sequence order. The first page
 * captures the head's current sequence as `throughSequence`; subsequent pages
 * never read beyond that watermark, even when new events arrive mid-drain.
 */
export async function queryChangeFeed(
  params: QueryChangeFeedRequest,
): Promise<QueryChangeFeedResponse> {
  const db = await useDatabase();
  const partitionKey = params.partitionKey
    ? contextPartitionKeySchema.parse(params.partitionKey)
    : undefined;
  await assertPartitionReadAllowed(db, params.userId, partitionKey);

  const [head] = await db
    .select({
      feedEpoch: memoryChangeFeedHeads.feedEpoch,
      nextSequence: memoryChangeFeedHeads.nextSequence,
    })
    .from(memoryChangeFeedHeads)
    .where(
      and(
        eq(memoryChangeFeedHeads.userId, params.userId),
        headPartitionFilter(partitionKey),
      ),
    )
    .limit(1);

  const currentFeedEpoch = head?.feedEpoch ?? CHANGE_FEED_SCHEMA_EPOCH;
  const currentMaxSequence = Math.max(0, (head?.nextSequence ?? 1) - 1);
  const cursor = params.cursor ? decodeCursor(params.cursor) : null;

  if (params.cursor && cursor === null) {
    return invalidCursor(
      "malformed",
      "The lifecycle-feed cursor is malformed or unsupported.",
      currentFeedEpoch,
      currentMaxSequence,
      null,
      partitionKey,
    );
  }

  if (cursor !== null) {
    if (cursor.userId !== params.userId) {
      return invalidCursor(
        "user_mismatch",
        "The lifecycle-feed cursor belongs to another user.",
        currentFeedEpoch,
        currentMaxSequence,
        cursor.feedEpoch,
        partitionKey,
      );
    }
    const cursorPartition = cursor.partitionKey ?? undefined;
    if (cursorPartition !== partitionKey) {
      return invalidCursor(
        "partition_mismatch",
        "The lifecycle-feed cursor belongs to another partition.",
        currentFeedEpoch,
        currentMaxSequence,
        cursor.feedEpoch,
        partitionKey,
      );
    }
    if (cursor.feedEpoch !== currentFeedEpoch) {
      return invalidCursor(
        "epoch_mismatch",
        "The lifecycle-feed epoch changed; rebuild a shadow projection.",
        currentFeedEpoch,
        currentMaxSequence,
        cursor.feedEpoch,
        partitionKey,
      );
    }
    if (
      cursor.throughSequence > currentMaxSequence ||
      cursor.sequence > cursor.throughSequence
    ) {
      return invalidCursor(
        "sequence_unavailable",
        "The lifecycle-feed cursor is outside the retained sequence range.",
        currentFeedEpoch,
        currentMaxSequence,
        cursor.feedEpoch,
        partitionKey,
      );
    }
  }

  // A completed checkpoint starts a new sweep without replaying consumed
  // events. Continuation cursors retain their original frozen watermark.
  const throughSequence =
    cursor === null || cursor.sequence === cursor.throughSequence
      ? currentMaxSequence
      : cursor.throughSequence;
  const afterSequence =
    cursor?.sequence ?? (params.startAt === "head" ? currentMaxSequence : 0);
  const rows = await db
    .select()
    .from(memoryChangeFeedEvents)
    .where(
      and(
        eq(memoryChangeFeedEvents.userId, params.userId),
        partitionFilter(partitionKey),
        eq(memoryChangeFeedEvents.feedEpoch, currentFeedEpoch),
        gt(memoryChangeFeedEvents.sequence, afterSequence),
        lte(memoryChangeFeedEvents.sequence, throughSequence),
      ),
    )
    .orderBy(memoryChangeFeedEvents.sequence)
    .limit(params.limit ?? 100);

  const sourceIds = rows.flatMap((row) =>
    row.sourceId === null ? [] : [row.sourceId],
  );
  const visibleSourceIds = new Set(
    (rows.length === 0
      ? []
      : await db
          .select({ sourceId: sources.id })
          .from(sources)
          .where(
            and(
              eq(sources.userId, params.userId),
              inArray(sources.id, sourceIds),
              isNull(sources.deletedAt),
              partitionKey === undefined
                ? isNull(sources.partitionKey)
                : eq(sources.partitionKey, partitionKey),
            ),
          )
    ).map((row) => row.sourceId),
  );
  const events = rows.map((row) => {
    const sourceUnavailable =
      row.sourceId !== null && !visibleSourceIds.has(row.sourceId);
    return changeFeedEventSchema.parse({
      eventId: row.eventId,
      userId: row.userId,
      partitionKey: row.partitionKey ?? null,
      feedEpoch: row.feedEpoch,
      sequence: row.sequence,
      kind: row.kind,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      sourceId: row.sourceId,
      effectiveChangeTime: row.effectiveChangeTime,
      provenance: sourceUnavailable ? null : nullableRecord(row.provenance),
      freshness: sourceUnavailable ? null : nullableRecord(row.freshness),
      status: sourceUnavailable ? "tombstoned" : row.status,
      payload: sourceUnavailable
        ? { redacted: true, sourceUnavailable: true }
        : requiredRecord(row.payload),
      tieBreaker: `${row.sequence}:${row.eventId}`,
    });
  });
  const lastSequence = rows.at(-1)?.sequence ?? afterSequence;
  const limit = params.limit ?? 100;
  const complete = lastSequence >= throughSequence || rows.length < limit;
  const nextCursor = complete
    ? null
    : encodeCursor({
        version: 1,
        userId: params.userId,
        partitionKey: partitionKey ?? null,
        feedEpoch: currentFeedEpoch,
        sequence: lastSequence,
        throughSequence,
      });
  const checkpointCursor = complete
    ? encodeCursor({
        version: 1,
        userId: params.userId,
        partitionKey: partitionKey ?? null,
        feedEpoch: currentFeedEpoch,
        sequence: throughSequence,
        throughSequence,
      })
    : null;

  return {
    feedSchemaEpoch: CHANGE_FEED_SCHEMA_EPOCH,
    feedEpoch: currentFeedEpoch,
    partitionKey: partitionKey ?? null,
    throughSequence,
    events,
    nextCursor,
    checkpointCursor,
    complete,
    pageComplete: complete,
  };
}

/** Common aliases: lifecycle feed, change feed, replay feed. */
export const getChangeFeed = queryChangeFeed;

/** Exposed for route and contract tests that need to validate opaque keys. */
export const changeFeedPartitionSchema = contextPartitionKeySchema;
