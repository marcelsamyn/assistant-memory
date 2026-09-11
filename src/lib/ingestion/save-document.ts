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
import { sourceMetadataSchema, sourceService } from "../sources";
import { updateDocumentTitle } from "./apply-document-spine";
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
import {
  PartitionAccessError,
  preparePartitionWrite,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import type { SourceProcessing } from "~/lib/schemas/source-processing";
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

  const inputMetadata = {
    documentIngestion: {
      documentId: document.id,
      contentType: document.contentType,
    },
    ...(document.author !== undefined && { author: document.author }),
    ...(document.title !== undefined && { title: document.title }),
    ...(document.sourceContext !== undefined && {
      sourceContext: document.sourceContext,
    }),
  };

  const {
    successes,
    failures,
    timestamp,
    metadata,
    revisionHash: contentHash,
  } = await sourceService.insertIngestionSource({
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
    timestamp: document.timestamp,
    extractionContentHash: hashSourceContent(document.content),
    extractionContentType: document.contentType,
    // Retain the original content; HTML conversion is stored separately.
    content: document.content,
    metadata: inputMetadata,
  });
  const author = metadata.author;

  let sourceId: TypeId<"source">;
  let sourceVersion: number | undefined;
  let existingProcessing: SourceProcessing | null = null;
  if (successes.length > 0) {
    sourceId = successes[0]!;
    const [created] = await db
      .select({ version: sources.version, metadata: sources.metadata })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (!created) throw new Error(`Created source ${sourceId} was not found`);
    if (
      sourceMetadataSchema.parse(created.metadata).rawContent !==
        document.content ||
      sourceMetadataSchema.parse(created.metadata).ingestionRevisionHash !==
        contentHash
    ) {
      throw new PartitionAccessError(
        "SOURCE_VERSION_CONFLICT",
        "Source content changed before its processing receipt was accepted",
        created.version,
      );
    }
    sourceVersion = created.version;
  } else {
    // Reuse the source identity; a queued receipt may still need its job.
    const [existing] = await db
      .select({
        id: sources.id,
        partitionKey: sources.partitionKey,
        metadata: sources.metadata,
      })
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

    existingProcessing = await findSourceIngestionOperation({
      db,
      userId,
      ...(req.partitionKey !== undefined
        ? { partitionKey: req.partitionKey }
        : {}),
      sourceId: existing.id,
      contentHash,
    });
    if (
      document.sourceContext === undefined &&
      existingProcessing?.status !== "queued"
    ) {
      return {
        message: "Document already ingested; reusing existing source",
        jobId: existingProcessing?.operationId ?? document.id,
        sourceId: existing.id,
        ...(existingProcessing !== null
          ? { ingestionOperationId: existingProcessing.operationId }
          : {}),
      };
    }
    if (document.sourceContext !== undefined) {
      const revision = {
        userId,
        sourceId: existing.id,
        partitionKey: req.partitionKey,
        metadata,
        ...(document.sourceContext?.parentSourceId !== undefined
          ? { parentId: document.sourceContext.parentSourceId }
          : {}),
        scope: document.scope,
      };
      if (existingProcessing) {
        const updatedVersion = await sourceService.updateIngestionMetadata({
          ...revision,
          ...(document.timestamp !== undefined
            ? { timestamp: document.timestamp }
            : {}),
        });
        existingProcessing = await findSourceIngestionOperation({
          db,
          userId,
          ...(req.partitionKey !== undefined
            ? { partitionKey: req.partitionKey }
            : {}),
          sourceId: existing.id,
          contentHash,
        });
        if (document.title !== undefined) {
          await updateDocumentTitle({
            db,
            userId,
            sourceId: existing.id,
            expectedSourceVersion: updatedVersion,
            title: document.title,
          });
        }
      } else if (
        sourceMetadataSchema.parse(existing.metadata).ingestionRevisionHash !==
          contentHash ||
        sourceMetadataSchema.parse(existing.metadata).rawContent !==
          document.content
      ) {
        sourceVersion = await sourceService.replaceInlineContent({
          ...revision,
          content: document.content,
          contentHash,
          timestamp,
          replaceDerivedLinks: true,
          status: "pending",
        });
      }
    }

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

    sourceId = existing.id;
  }

  const processing =
    existingProcessing ??
    (await createSourceIngestionOperation({
      db,
      userId,
      ...(req.partitionKey !== undefined
        ? { partitionKey: req.partitionKey }
        : {}),
      sourceId,
      externalId,
      contentHash,
      ...(sourceVersion !== undefined
        ? { expectedSourceVersion: sourceVersion }
        : {}),
    }));

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
      author,
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
    message:
      successes.length > 0
        ? "Document ingestion job accepted"
        : "Document already ingested; reusing existing source",
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
