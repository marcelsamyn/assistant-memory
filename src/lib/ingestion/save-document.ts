/**
 * Orchestrator for `POST /ingest/document`.
 *
 * Source-row creation happens here (synchronously, in the route call) so the
 * caller gets a deterministic `sourceId` back immediately and can hand it to
 * project auto-attach flows. Heavy work — HTML→markdown conversion and graph
 * extraction — runs in the queued `ingest-document` worker.
 *
 * Contextual revisions retain their source identity. Legacy `updateExisting`
 * requests retain the historical erase-and-recreate behavior.
 */
import { batchQueue } from "../queues";
import {
  IngestDocumentRequest,
  IngestDocumentResponse,
} from "../schemas/ingest-document-request";
import { sourceService } from "../sources";
import { ensureUser } from "./ensure-user";
import { contextualSourceExternalId } from "./source-identity";
import {
  createSourceIngestionOperation,
  findSourceIngestionOperation,
  hashSourceContent,
} from "./source-processing";
import { and, eq, isNull } from "drizzle-orm";
import { createError } from "h3";
import { randomUUID } from "node:crypto";
import db from "~/db";
import { sourceTombstones, sources } from "~/db/schema";
import { preparePartitionWrite } from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import {
  applySourceLifecycleCommand,
  listSourceTreeStorageCleanupIds,
  markSourceTreeStorageCleanupCompleted,
} from "~/lib/source-lifecycle";
import type { TypeId } from "~/types/typeid";

/**
 * Queue a document ingestion job.
 */
export async function saveMemory(
  req: IngestDocumentRequest,
): Promise<IngestDocumentResponse> {
  const { userId, document, updateExisting = false } = req;
  const externalId = contextualSourceExternalId({
    externalId: document.id,
    ...(document.sourceContext !== undefined
      ? {
          accountId: document.sourceContext.accountId,
          ...(req.partitionKey !== undefined
            ? { partitionKey: req.partitionKey }
            : {}),
        }
      : {}),
  });
  const contentHash = hashSourceContent(document.content);

  if (
    document.sourceContext?.parentPartitionKey !== undefined &&
    document.sourceContext.parentPartitionKey !== req.partitionKey
  ) {
    throw createError({
      statusCode: 403,
      statusMessage: "source parent does not belong to the requested partition",
    });
  }

  await ensureUser(db, userId);
  await preparePartitionWrite(db, userId, req.partitionKey);

  if (updateExisting && document.sourceContext === undefined) {
    const existingDocuments = await db
      .select({
        id: sources.id,
        version: sources.version,
        deletedAt: sources.deletedAt,
      })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          req.partitionKey === undefined
            ? isNull(sources.partitionKey)
            : eq(sources.partitionKey, req.partitionKey),
          eq(sources.type, "document"),
          eq(sources.externalId, externalId),
        ),
      )
      .orderBy(sources.id);
    for (const existing of existingDocuments) {
      await releaseDocumentIdentity({
        userId,
        sourceId: existing.id,
        sourceVersion: existing.version,
        partitionKey: req.partitionKey ?? null,
        alreadyTombstoned: existing.deletedAt !== null,
      });
    }
  }

  const timestamp = document.timestamp ?? new Date();
  const metadata = {
    ...(document.author !== undefined && { author: document.author }),
    ...(document.title !== undefined && { title: document.title }),
    ...(document.sourceContext !== undefined && {
      sourceContext: document.sourceContext,
    }),
  };

  const { successes, failures } = await sourceService.insertMany([
    {
      userId,
      ...(req.partitionKey !== undefined
        ? { partitionKey: req.partitionKey }
        : {}),
      sourceType: "document",
      externalId,
      ...(document.sourceContext?.parentSourceId !== undefined
        ? {
            parentId: document.sourceContext.parentSourceId,
            ...(req.partitionKey !== undefined
              ? { parentPartitionKey: req.partitionKey }
              : {}),
          }
        : {}),
      scope: document.scope,
      timestamp,
      // Stored as-is; the worker re-writes `metadata.rawContent` with the
      // converted markdown when `contentType === "html"`.
      content: document.content,
      metadata,
    },
  ]);

  let sourceId: TypeId<"source">;
  if (successes.length > 0) {
    sourceId = successes[0]!;
    const [created] = await db
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (!created) throw new Error(`Created source ${sourceId} was not found`);
  } else {
    // Conflict path: the row already existed and updateExisting was false.
    // Look up the existing sourceId so the caller can still auto-attach,
    // and skip the worker (no extraction work to do).
    const [existing] = await db
      .select({ id: sources.id, partitionKey: sources.partitionKey })
      .from(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.type, "document"),
          eq(sources.externalId, externalId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw createError({
        statusCode: 500,
        statusMessage: `failed to persist source: ${
          failures[0]?.reason ?? "no row inserted"
        }`,
      });
    }
    if (existing.partitionKey !== (req.partitionKey ?? null)) {
      throw createError({
        statusCode: 409,
        statusMessage:
          "document source already belongs to a different memory partition",
      });
    }

    const existingProcessing = await findSourceIngestionOperation({
      db,
      userId,
      ...(req.partitionKey !== undefined
        ? { partitionKey: req.partitionKey }
        : {}),
      sourceId: existing.id,
      contentHash,
    });
    if (document.sourceContext === undefined) {
      return {
        message: "Document already ingested; reusing existing source",
        jobId: existingProcessing?.operationId ?? document.id,
        sourceId: existing.id,
        ...(existingProcessing !== null
          ? { ingestionOperationId: existingProcessing.operationId }
          : {}),
      };
    }
    await sourceService.replaceInlineContent({
      userId,
      sourceId: existing.id,
      partitionKey: req.partitionKey,
      content: document.content,
      metadata,
      ...(document.sourceContext?.parentSourceId !== undefined
        ? { parentId: document.sourceContext.parentSourceId }
        : {}),
      scope: document.scope,
      timestamp,
      replaceDerivedLinks: existingProcessing === null,
      ...(existingProcessing === null ? { status: "pending" as const } : {}),
    });

    // Identical content reuses its immutable processing receipt. Metadata is
    // still revised in place, but no extraction job is repeated.
    if (existingProcessing && existingProcessing.status !== "queued") {
      return {
        message: "Document already ingested; metadata updated",
        jobId: existingProcessing.operationId,
        sourceId: existing.id,
        ingestionOperationId: existingProcessing.operationId,
      };
    }

    const processing =
      existingProcessing ??
      (await createSourceIngestionOperation({
        db,
        userId,
        ...(req.partitionKey !== undefined
          ? { partitionKey: req.partitionKey }
          : {}),
        sourceId: existing.id,
        externalId,
        contentHash,
      }));
    await batchQueue.add(
      "ingest-document",
      {
        userId,
        ...(req.partitionKey !== undefined
          ? { partitionKey: req.partitionKey }
          : {}),
        sourceId: existing.id,
        expectedSourceVersion: processing.sourceVersion,
        documentId: document.id,
        externalId,
        contentType: document.contentType,
        timestamp: timestamp.toISOString(),
        author: document.author,
        title: document.title,
        operationId: processing.operationId,
      },
      {
        jobId: processing.operationId,
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
      },
    );
    return {
      message: "Document already ingested; reusing existing source",
      jobId: processing.operationId,
      sourceId: existing.id,
      ingestionOperationId: processing.operationId,
    };
  }

  const processing = await createSourceIngestionOperation({
    db,
    userId,
    ...(req.partitionKey !== undefined
      ? { partitionKey: req.partitionKey }
      : {}),
    sourceId,
    externalId,
    contentHash,
  });

  await batchQueue.add(
    "ingest-document",
    {
      userId,
      partitionKey: req.partitionKey,
      sourceId,
      expectedSourceVersion: processing.sourceVersion,
      documentId: document.id,
      externalId,
      contentType: document.contentType,
      timestamp: timestamp.toISOString(),
      author: document.author,
      title: document.title,
      operationId: processing.operationId,
    },
    {
      jobId: processing.operationId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
    },
  );

  return {
    message: "Document ingestion job accepted",
    jobId: processing.operationId,
    sourceId,
    ingestionOperationId: processing.operationId,
  };
}

/** Erases a prior document source before releasing its external-id slot. */
async function releaseDocumentIdentity(input: {
  userId: string;
  sourceId: TypeId<"source">;
  sourceVersion: number;
  partitionKey: ContextPartitionKey | null;
  alreadyTombstoned: boolean;
}): Promise<void> {
  let sourceVersion = input.sourceVersion;
  if (!input.alreadyTombstoned) {
    const tombstone = await applySourceLifecycleCommand(db, {
      userId: input.userId,
      sourceId: input.sourceId,
      expectedPartitionKey: input.partitionKey,
      expectedSourceVersion: sourceVersion,
      commandId: randomUUID(),
      action: "tombstone",
    });
    sourceVersion = tombstone.sourceVersion ?? sourceVersion;
  } else {
    const [tombstone] = await db
      .select({ state: sourceTombstones.state })
      .from(sourceTombstones)
      .where(
        and(
          eq(sourceTombstones.userId, input.userId),
          eq(sourceTombstones.sourceId, input.sourceId),
        ),
      )
      .limit(1);
    if (tombstone?.state !== "tombstoned") {
      throw createError({
        statusCode: 409,
        statusMessage:
          "document replacement requires a live source or a pending tombstone",
      });
    }
  }

  const sourceIds = await listSourceTreeStorageCleanupIds(
    db,
    input.userId,
    input.sourceId,
  );
  await Promise.all(
    sourceIds.map((sourceId) =>
      sourceService.deleteRawBlobIfPresent(input.userId, sourceId),
    ),
  );
  await markSourceTreeStorageCleanupCompleted(db, input.userId, input.sourceId);
  await applySourceLifecycleCommand(db, {
    userId: input.userId,
    sourceId: input.sourceId,
    expectedPartitionKey: input.partitionKey,
    expectedSourceVersion: sourceVersion,
    commandId: randomUUID(),
    action: "restore",
  });
}
