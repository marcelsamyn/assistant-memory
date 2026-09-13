import { parseISO } from "date-fns";
import { and, eq } from "drizzle-orm";
import db from "~/db";
import { sources } from "~/db/schema";
import { ensureUser } from "~/lib/ingestion/ensure-user";
import { IngestConversationJobInput } from "~/lib/jobs/ingest-conversation";
import {
  assertPartitionReadAllowed,
  ensurePersonalPartition,
  PartitionAccessError,
} from "~/lib/partition-access";
import { throwPartitionRouteError } from "~/lib/partition-route-errors";
import { batchQueue } from "~/lib/queues";
import { getRequestAccessScope } from "~/lib/request-access";
import {
  ingestConversationRequestSchema,
  ingestConversationResponseSchema,
} from "~/lib/schemas/ingest-conversation";
import { assertWorkspaceOperationReady } from "~/lib/workspace-partitions";

export default defineEventHandler(async (event) => {
  try {
    const {
      userId,
      partitionKey: requestedPartitionKey,
      conversation,
    } = ingestConversationRequestSchema.parse(await readBody(event));
    const accessScope = getRequestAccessScope(event);
    let partitionKey = requestedPartitionKey;
    if (accessScope === "workspace") {
      const [existing] = await db
        .select({
          partitionKey: sources.partitionKey,
          deletedAt: sources.deletedAt,
        })
        .from(sources)
        .where(
          and(
            eq(sources.userId, userId),
            eq(sources.type, "conversation"),
            eq(sources.externalId, conversation.id),
          ),
        )
        .limit(1);
      if (existing?.deletedAt !== undefined && existing.deletedAt !== null) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Conversation source has been tombstoned",
        );
      }
      const existingPartitionKey = existing?.partitionKey ?? undefined;
      if (
        existing !== undefined &&
        partitionKey !== undefined &&
        partitionKey !== existingPartitionKey
      ) {
        throw new PartitionAccessError(
          "PARTITION_UNAUTHORIZED",
          "Conversation source already belongs to a different memory partition",
        );
      }
      if (existing !== undefined) {
        partitionKey = existingPartitionKey;
      } else {
        partitionKey =
          partitionKey ?? (await ensurePersonalPartition(db, userId));
      }
      await assertWorkspaceOperationReady(
        db,
        userId,
        [partitionKey],
        accessScope,
      );
      // Resolve a newly-created migrated conversation to the Memory-owned
      // personal partition before checking readiness. Existing sources are
      // checked against their actual partition so quarantined or foreign
      // rows cannot be queued through the aggregate route.
      await assertPartitionReadAllowed(db, userId, partitionKey);
    }
    await ensureUser(db, userId);

    const jobInput: IngestConversationJobInput = {
      userId,
      partitionKey,
      conversationId: conversation.id,
      messages: conversation.messages.map((m) => ({
        id: m.id,
        content: m.content,
        role: m.role,
        name: m.name,
        timestamp: parseISO(m.timestamp),
      })),
    };

    await batchQueue.add("ingest-conversation", jobInput);

    return ingestConversationResponseSchema.parse({
      message: "Conversation ingestion job accepted",
      jobId: conversation.id,
    });
  } catch (error) {
    throwPartitionRouteError(error);
  }
});
