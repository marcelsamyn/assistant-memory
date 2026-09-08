/**
 * Orchestrator for `POST /ingest/document`.
 *
 * Source-row creation happens here (synchronously, in the route call) so the
 * caller gets a deterministic `sourceId` back immediately and can hand it to
 * project auto-attach flows. Heavy work — HTML→markdown conversion and graph
 * extraction — runs in the queued `ingest-document` worker.
 *
 * On `updateExisting`, the prior source is retired through the durable source
 * lifecycle. The replacement deliberately receives a new source identity;
 * no prior content, evidence, or feed payload is revived.
 */
import { batchQueue } from "../queues";
import {
  IngestDocumentRequest,
  IngestDocumentResponse,
} from "../schemas/ingest-document-request";
import { sourceService } from "../sources";
import { ensureUser } from "./ensure-user";
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

  await ensureUser(db, userId);
  await preparePartitionWrite(db, userId, req.partitionKey);

  if (updateExisting) {
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
          eq(sources.externalId, document.id),
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

  const { successes, failures } = await sourceService.insertMany([
    {
      userId,
      ...(req.partitionKey !== undefined
        ? { partitionKey: req.partitionKey }
        : {}),
      sourceType: "document",
      externalId: document.id,
      scope: document.scope,
      timestamp,
      // Stored as-is; the worker re-writes `metadata.rawContent` with the
      // converted markdown when `contentType === "html"`.
      content: document.content,
      metadata: {
        ...(document.author !== undefined && { author: document.author }),
        ...(document.title !== undefined && { title: document.title }),
      },
    },
  ]);

  let sourceId: TypeId<"source">;
  let expectedSourceVersion: number;
  if (successes.length > 0) {
    sourceId = successes[0]!;
    const [created] = await db
      .select({ version: sources.version })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (!created) throw new Error(`Created source ${sourceId} was not found`);
    expectedSourceVersion = created.version;
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
          eq(sources.externalId, document.id),
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

    return {
      message: "Document already ingested; reusing existing source",
      jobId: document.id,
      sourceId: existing.id,
    };
  }

  await batchQueue.add("ingest-document", {
    userId,
    partitionKey: req.partitionKey,
    sourceId,
    expectedSourceVersion,
    documentId: document.id,
    contentType: document.contentType,
    timestamp: timestamp.toISOString(),
    author: document.author,
    title: document.title,
  });

  return {
    message: "Document ingestion job accepted",
    jobId: document.id,
    sourceId,
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
