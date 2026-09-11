import { extractDocumentGraph } from "./extract-document-graph";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { assertSourcePartition } from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { SourceContext } from "~/lib/schemas/source-context";
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import type { TypeId } from "~/types/typeid";

/** Attachment processing completes only after its parent has used the converted evidence. */
export async function extractEmailAttachment(params: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  expectedSourceVersion: number;
  partitionKey: ContextPartitionKey | undefined;
  context: SourceContext;
}): Promise<void> {
  const { db, userId, sourceId, expectedSourceVersion, partitionKey, context } =
    params;
  if (context.parentSourceId === undefined) return;
  await assertSourcePartition({
    db,
    userId,
    sourceId,
    expectedSourceVersion,
    partitionKey,
  });
  const [parent] = await db
    .select()
    .from(sources)
    .where(
      and(
        eq(sources.id, context.parentSourceId),
        eq(sources.userId, userId),
        isNull(sources.deletedAt),
      ),
    )
    .limit(1);
  if (!parent)
    throw new Error("Email attachment parent is no longer available");
  const metadata = sourceMetadataSchema.parse(parent.metadata);
  const parentContext = metadata.sourceContext;
  if (
    parent.partitionKey !== (partitionKey ?? null) ||
    parentContext?.sourceKind !== "email" ||
    parentContext.accountId !== context.accountId ||
    (context.messageId !== undefined &&
      context.messageId !== parentContext.messageId) ||
    (context.threadId !== undefined &&
      context.threadId !== parentContext.threadId)
  )
    throw new Error("Email attachment does not match its parent email");
  if (
    metadata.documentIngestion?.contentType === "html" &&
    metadata.convertedToMarkdown !== true
  )
    throw new Error("Email attachment parent is waiting for HTML conversion");
  const content =
    metadata.convertedMarkdown ??
    metadata.rawContent ??
    (await sourceService.fetchText(userId, parent.id));
  await extractDocumentGraph({
    db,
    userId,
    sourceId: parent.id,
    expectedSourceVersion: parent.version,
    externalId: parent.externalId,
    content,
    timestamp:
      parentContext.authoredAt === undefined
        ? (parent.lastIngestedAt ?? parent.createdAt)
        : new Date(parentContext.authoredAt),
    logLabel: parent.externalId,
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    emailContent: true,
  });
}
