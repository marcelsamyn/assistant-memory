import { and, eq, inArray, isNull } from "drizzle-orm";
import { Client as MinioClient } from "minio";
import { randomUUID } from "node:crypto";
import { Readable } from "stream";
import { z } from "zod";
import db, { type DrizzleDB } from "~/db";
import {
  sourceBlobUploads,
  sourceIngestionOperations,
  sourceTombstones,
  sources,
  SourcesInsert,
} from "~/db/schema";
import { invalidateSourceExtractionRevision } from "~/lib/ingestion/source-revision";
import { logEvent } from "~/lib/observability/log";
import {
  PartitionAccessError,
  assertSourceIdentitiesActive,
  assertLiveSourceParents,
  lockSourceIdentityGates,
  lockSourceParentAttachmentGates,
  preparePartitionWrite,
  type SourceWriteFence,
  type SourceIdentity,
  withSourceWriteFence,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
import { sourceContextSchema } from "~/lib/schemas/source-context";
import {
  putSourceBlob,
  SourceBlobUploadTimeoutError,
} from "~/lib/source-blob-put";
import { Scope, SourceType } from "~/types/graph";
import { typeIdSchema, type TypeId } from "~/types/typeid";
import { env } from "~/utils/env";

export const sourceMetadataSchema = z
  .object({
    rawContent: z.string().optional(),
    convertedToMarkdown: z.literal(true).optional(),
    /** Internal identity of the bytes and context accepted for extraction. */
    ingestionRevisionHash: z.string().optional(),
    /** Reference attribution surfaced via NodeCard.reference for reference-scope sources. */
    author: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    /**
     * Transcript speaker provenance (Phase 4 PR 4ii-b). Persisted on each
     * `conversation_message` child source ingested via `/transcript/ingest`
     * so re-extraction is deterministic without re-running speaker
     * resolution.
     */
    speakerLabel: z.string().min(1).optional(),
    speakerNodeId: z.string().min(1).optional(),
    sourceContext: sourceContextSchema.optional(),
  })
  .catchall(z.unknown());
type Metadata = z.infer<typeof sourceMetadataSchema>;
type BlobUploadReservation = {
  previous: typeof sourceBlobUploads.$inferSelect | undefined;
  updatedAt: Date;
};

function isTextContentType(contentType: string | undefined): boolean {
  return contentType?.startsWith("text/") ?? false;
}

const storageErrorSchema = z
  .object({
    code: z.string().optional(),
    statusCode: z.number().optional(),
    cause: z.unknown().optional(),
  })
  .passthrough();

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isMissingSourceBlobError(error: unknown): boolean {
  const parsed = storageErrorSchema.safeParse(error);
  if (!parsed.success) return false;

  const code = parsed.data.code;
  if (code === "NoSuchKey" || code === "NotFound") return true;
  if (parsed.data.statusCode === 404) return true;

  return parsed.data.cause
    ? isMissingSourceBlobError(parsed.data.cause)
    : false;
}

function sourceObjectPrefix(userId: string): string {
  return `${userId}/`;
}

export function sourceBlobObjectKey(
  userId: string,
  sourceId: TypeId<"source">,
): string {
  return `${sourceObjectPrefix(userId)}${sourceId}`;
}

function parseSourceIdFromObjectName(
  userId: string,
  objectName: string,
): TypeId<"source"> | null {
  const prefix = sourceObjectPrefix(userId);
  if (!objectName.startsWith(prefix)) return null;

  const parsed = typeIdSchema("source").safeParse(
    objectName.slice(prefix.length),
  );
  return parsed.success ? parsed.data : null;
}

export interface SourceBlobStore {
  listBlobSourceIds(userId: string): Promise<ReadonlySet<TypeId<"source">>>;
}

/** Test/adapter seam around an externally visible blob upload. */
export interface SourceBlobUploadHooks {
  beforePut?: (input: {
    userId: string;
    sourceId: TypeId<"source">;
    objectKey: string;
  }) => Promise<void>;
}

/** Discriminated union of inline vs blob payload */
export type RawResult =
  | { kind: "inline"; sourceId: string; content: string }
  | { kind: "blob"; sourceId: string; buffer: Buffer; contentType: string };

/** Input for creating a source */
export interface SourceCreateInput {
  userId: string;
  partitionKey?: ContextPartitionKey;
  sourceType: SourceType;
  externalId: string;
  parentId?: TypeId<"source">;
  parentPartitionKey?: ContextPartitionKey;
  scope?: Scope;
  timestamp: Date;
  metadata?: Metadata;
  /** for inline smaller content */
  content?: string;
  /** for larger binary content */
  fileBuffer?: Buffer;
  /** contentType for blob, e.g. "text/plain" */
  contentType?: string;
}

/**
 * Service for managing sources and raw payload storage.
 */
export class SourceService {
  private bucketReady: Promise<void> | null = null;

  constructor(
    private db: DrizzleDB,
    private minioClient: MinioClient,
    private bucket: string,
    private inlineThreshold = 1024, // bytes
    private blobUploadHooks: SourceBlobUploadHooks = {},
    private blobUploadTimeoutMs = env.SOURCE_BLOB_UPLOAD_TIMEOUT_MS,
  ) {}

  /** Ensure the S3/MinIO bucket exists, creating it if necessary */
  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = this.minioClient
        .bucketExists(this.bucket)
        .then((exists) => {
          if (!exists) {
            return this.minioClient.makeBucket(this.bucket);
          }
          return;
        })
        .catch((err) => {
          // Reset so next call retries
          this.bucketReady = null;
          throw err;
        });
    }
    return this.bucketReady;
  }

  /** Insert multiple sources with optional inline or blob payloads */
  async insertMany(
    inputs: SourceCreateInput[],
    rootWriteFence?: { userId: string; source: SourceWriteFence },
  ): Promise<{
    successes: TypeId<"source">[];
    failures: Array<{ sourceId?: TypeId<"source">; reason: string }>;
  }> {
    const successes: TypeId<"source">[] = [];
    const failures: Array<{ sourceId?: TypeId<"source">; reason: string }> = [];

    await Promise.all(
      [
        ...new Map(
          inputs.map((input) => [
            `${input.userId}:${input.partitionKey ?? "<legacy>"}`,
            input,
          ]),
        ).values(),
      ].map((input) =>
        preparePartitionWrite(this.db, input.userId, input.partitionKey),
      ),
    );

    // 1. Bulk insert initial source rows with status pending
    const insertRows = inputs.map(
      (input): SourcesInsert => ({
        userId: input.userId,
        partitionKey: input.partitionKey,
        type: input.sourceType,
        externalId: input.externalId,
        parentSource: input.parentId,
        scope: input.scope ?? "personal",
        metadata: sourceMetadataSchema.parse(input.metadata ?? {}),
        lastIngestedAt: input.timestamp,
        status: "pending" as const,
      }),
    );

    const inputLookup = new Map<string, SourceCreateInput>();
    const makeLookupKey = (
      userId: string,
      type: SourceType,
      externalId: string,
    ) => `${userId}:${type}:${externalId}`;
    inputs.forEach((input) => {
      inputLookup.set(
        makeLookupKey(input.userId, input.sourceType, input.externalId),
        input,
      );
    });
    const sourceIdentities = inputs.map(
      (input): SourceIdentity => ({
        userId: input.userId,
        sourceType: input.sourceType,
        externalId: input.externalId,
      }),
    );

    const insertSourceRows = (database: DrizzleDB) =>
      database
        .insert(sources)
        .values(insertRows)
        .onConflictDoNothing({
          target: [sources.userId, sources.type, sources.externalId],
        })
        .returning();
    const parentAttachments = inputs.flatMap((input) =>
      input.parentId
        ? (() => {
            const partitionKey = input.parentPartitionKey ?? input.partitionKey;
            return [
              {
                userId: input.userId,
                sourceId: input.parentId,
                ...(partitionKey !== undefined ? { partitionKey } : {}),
              },
            ];
          })()
        : [],
    );
    const insertWithParentAttachmentFence = async (
      database: DrizzleDB,
      gatesAlreadyHeld = false,
    ) => {
      if (!gatesAlreadyHeld) {
        await lockSourceIdentityGates(database, sourceIdentities);
      }
      await assertSourceIdentitiesActive(database, sourceIdentities);
      if (!gatesAlreadyHeld) {
        await lockSourceParentAttachmentGates(database, parentAttachments);
      }
      await assertLiveSourceParents(database, parentAttachments);
      return insertSourceRows(database);
    };
    const inserted = rootWriteFence
      ? await withSourceWriteFence(
          this.db,
          {
            userId: rootWriteFence.userId,
            sources: [rootWriteFence.source],
            sourceIdentities,
            beforeSourceLocks: (tx) =>
              lockSourceParentAttachmentGates(tx, parentAttachments),
          },
          (tx) => insertWithParentAttachmentFence(tx, true),
        )
      : await this.db.transaction((tx) => insertWithParentAttachmentFence(tx));

    const writePayload = <T>(
      row: (typeof inserted)[number],
      write: (database: DrizzleDB) => Promise<T>,
    ) =>
      withSourceWriteFence(
        this.db,
        {
          userId: row.userId,
          sources: [
            { sourceId: row.id },
            ...(rootWriteFence ? [rootWriteFence.source] : []),
          ],
        },
        (tx) => write(tx),
      );

    // 2. Handle payloads
    await this.ensureBucket();
    for (const row of inserted) {
      const lookupKey = makeLookupKey(row.userId, row.type, row.externalId);
      const input = inputLookup.get(lookupKey);
      if (!input) {
        console.warn(
          `No matching input found for inserted source ${row.id} (${lookupKey})`,
        );
        continue;
      }
      // Inline text when small enough. Binary bytes always use the blob path,
      // even when they fit the inline threshold; UTF-8 decoding a PDF here
      // would permanently corrupt the payload before conversion can run.
      if (
        input.content !== undefined ||
        (input.fileBuffer &&
          input.fileBuffer.length <= this.inlineThreshold &&
          isTextContentType(input.contentType))
      ) {
        const existingMeta = sourceMetadataSchema.parse(row.metadata);
        const updatedMeta: Metadata = {
          ...existingMeta,
          rawContent: input.content ?? input.fileBuffer!.toString("utf-8"),
        };
        try {
          await writePayload(row, (database) =>
            database
              .update(sources)
              .set({ metadata: updatedMeta, status: "completed" })
              .where(eq(sources.id, row.id)),
          );
          successes.push(row.id);
        } catch (err: unknown) {
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
      // Blob payload
      else if (input.fileBuffer) {
        try {
          await this.reserveSourceBlobUpload(row, rootWriteFence);
          await this.beginSourceBlobUpload(row, rootWriteFence);
          await this.putSourceBlobWithFence(
            row,
            input.fileBuffer,
            input.contentType,
            rootWriteFence,
          );
          successes.push(row.id);
        } catch (err: unknown) {
          // A timed-out PUT has a durable unknown receipt. Only an observed
          // storage commit can release that receipt for cleanup.
          if (!(err instanceof SourceBlobUploadTimeoutError)) {
            await this.scheduleFailedSourceBlobUploadCleanup(row);
          }
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
      // no payload
      else {
        try {
          await writePayload(row, (database) =>
            database
              .update(sources)
              .set({ status: "completed" as const })
              .where(eq(sources.id, row.id)),
          );
          successes.push(row.id);
        } catch (err: unknown) {
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
    }

    return { successes, failures };
  }

  /** Updates one inline revision while retaining the stable source identity. */
  async replaceInlineContent(input: {
    userId: string;
    sourceId: TypeId<"source">;
    partitionKey: ContextPartitionKey | undefined;
    content: string;
    contentHash?: string;
    metadata: Metadata;
    parentId?: TypeId<"source">;
    scope: Scope;
    timestamp: Date;
    replaceDerivedLinks?: boolean;
    status?: SourcesInsert["status"];
  }): Promise<number> {
    const parentAttachments = input.parentId
      ? [
          {
            userId: input.userId,
            sourceId: input.parentId,
            ...(input.partitionKey !== undefined
              ? { partitionKey: input.partitionKey }
              : {}),
          },
        ]
      : [];
    return withSourceWriteFence(
      this.db,
      {
        userId: input.userId,
        partitionKey: input.partitionKey,
        sources: [{ sourceId: input.sourceId }],
        beforeSourceLocks: (tx) =>
          lockSourceParentAttachmentGates(tx, parentAttachments),
      },
      async (tx) => {
        await assertLiveSourceParents(tx, parentAttachments);
        if (input.contentHash !== undefined) {
          const [accepted] = await tx
            .select({ operationId: sourceIngestionOperations.operationId })
            .from(sourceIngestionOperations)
            .where(
              and(
                eq(sourceIngestionOperations.userId, input.userId),
                eq(sourceIngestionOperations.sourceId, input.sourceId),
                eq(sourceIngestionOperations.contentHash, input.contentHash),
              ),
            )
            .limit(1);
          if (accepted) {
            throw new PartitionAccessError(
              "SOURCE_VERSION_CONFLICT",
              "Source revision was accepted concurrently; retry to reuse its receipt",
            );
          }
        }
        const [updated] = await tx
          .update(sources)
          .set({
            metadata: { ...input.metadata, rawContent: input.content },
            parentSource: input.parentId ?? null,
            scope: input.scope,
            lastIngestedAt: input.timestamp,
            ...(input.status !== undefined ? { status: input.status } : {}),
            contentType: null,
            contentLength: null,
          })
          .where(
            and(
              eq(sources.userId, input.userId),
              eq(sources.id, input.sourceId),
            ),
          )
          .returning({ version: sources.version });
        if (!updated)
          throw new Error(
            `Source ${input.sourceId} disappeared while updating content`,
          );
        if (input.replaceDerivedLinks) {
          await invalidateSourceExtractionRevision(
            tx,
            input.userId,
            input.sourceId,
          );
        }
        return updated.version;
      },
    );
  }

  /** Revises caller-owned metadata without changing bytes or processing state. */
  async updateIngestionMetadata(input: {
    userId: string;
    sourceId: TypeId<"source">;
    partitionKey: ContextPartitionKey | undefined;
    metadata: Metadata;
    parentId?: TypeId<"source">;
    scope: Scope;
    timestamp?: Date;
  }): Promise<number> {
    const parentAttachments = input.parentId
      ? [
          {
            userId: input.userId,
            sourceId: input.parentId,
            ...(input.partitionKey !== undefined
              ? { partitionKey: input.partitionKey }
              : {}),
          },
        ]
      : [];
    return withSourceWriteFence(
      this.db,
      {
        userId: input.userId,
        partitionKey: input.partitionKey,
        sources: [{ sourceId: input.sourceId }],
        beforeSourceLocks: (tx) =>
          lockSourceParentAttachmentGates(tx, parentAttachments),
      },
      async (tx) => {
        await assertLiveSourceParents(tx, parentAttachments);
        const [current] = await tx
          .select({ metadata: sources.metadata, version: sources.version })
          .from(sources)
          .where(
            and(
              eq(sources.userId, input.userId),
              eq(sources.id, input.sourceId),
            ),
          )
          .limit(1);
        if (!current) {
          throw new Error(
            `Source ${input.sourceId} disappeared while updating metadata`,
          );
        }
        const currentMetadata = sourceMetadataSchema.parse(
          current.metadata ?? {},
        );
        if (
          input.metadata.ingestionRevisionHash !== undefined &&
          input.metadata.ingestionRevisionHash !==
            currentMetadata.ingestionRevisionHash
        ) {
          throw new PartitionAccessError(
            "SOURCE_VERSION_CONFLICT",
            "Source revision changed before its metadata was updated",
            current.version,
          );
        }
        const [updated] = await tx
          .update(sources)
          .set({
            metadata: {
              ...currentMetadata,
              ...input.metadata,
            },
            parentSource: input.parentId ?? null,
            scope: input.scope,
            ...(input.timestamp !== undefined
              ? { lastIngestedAt: input.timestamp }
              : {}),
          })
          .where(
            and(
              eq(sources.userId, input.userId),
              eq(sources.id, input.sourceId),
            ),
          )
          .returning({ version: sources.version });
        if (!updated) {
          throw new Error(
            `Source ${input.sourceId} disappeared while updating metadata`,
          );
        }
        if (updated.version !== current.version) {
          await tx
            .update(sourceIngestionOperations)
            .set({ sourceVersion: updated.version, updatedAt: new Date() })
            .where(
              and(
                eq(sourceIngestionOperations.userId, input.userId),
                eq(sourceIngestionOperations.sourceId, input.sourceId),
                eq(sourceIngestionOperations.sourceVersion, current.version),
                inArray(sourceIngestionOperations.status, [
                  "queued",
                  "processing",
                ]),
              ),
            );
        }
        return updated.version;
      },
    );
  }

  /**
   * Replaces bytes under the source lifecycle fence. The object key is stable,
   * so revisions preserve source links while an ingestion receipt identifies
   * the exact bytes being extracted.
   */
  async replaceFileContent(input: {
    userId: string;
    sourceId: TypeId<"source">;
    partitionKey: ContextPartitionKey | undefined;
    buffer: Buffer;
    contentType: string;
    externalId: string;
    contentHash: string;
    metadata: Metadata;
    parentId?: TypeId<"source">;
    scope: Scope;
    timestamp: Date;
  }): Promise<number> {
    await this.ensureBucket();
    const [source] = await this.db
      .select()
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!source) {
      throw new Error(
        `Source ${input.sourceId} disappeared while updating content`,
      );
    }
    if (
      source.partitionKey !== (input.partitionKey ?? null) ||
      source.externalId !== input.externalId
    ) {
      throw new PartitionAccessError(
        "PARTITION_UNAUTHORIZED",
        "Source no longer matches the requested file identity and partition",
      );
    }
    const writeFence = {
      userId: input.userId,
      source: {
        sourceId: input.sourceId,
        expectedSourceVersion: source.version,
      },
    };
    let reservation: BlobUploadReservation | undefined;
    let putStarted = false;
    try {
      reservation = await this.reserveSourceBlobUpload(
        source,
        writeFence,
        true,
        input.contentHash,
      );
      reservation.updatedAt = await this.beginSourceBlobUpload(
        source,
        writeFence,
      );
      await this.putSourceBlobWithFence(
        source,
        input.buffer,
        input.contentType,
        writeFence,
        {
          metadata: input.metadata,
          parentSource: input.parentId ?? null,
          scope: input.scope,
          lastIngestedAt: input.timestamp,
          status: "pending",
          replaceDerivedLinks: true,
          operation: {
            externalId: input.externalId,
            contentHash: input.contentHash,
          },
        },
        {
          updatedAt: reservation.updatedAt,
          onPutStarted: () => {
            putStarted = true;
          },
        },
      );
    } catch (error: unknown) {
      if (
        reservation?.previous?.state === "uploaded" &&
        !(error instanceof SourceBlobUploadTimeoutError)
      ) {
        // A failed replacement must not schedule deletion of the stable key:
        // it still contains the last committed source revision.
        await this.cancelSourceBlobUploadBeforePut(source, reservation);
      } else if (reservation && !putStarted) {
        await this.cancelSourceBlobUploadBeforePut(source, reservation);
      } else if (
        putStarted &&
        !(error instanceof SourceBlobUploadTimeoutError)
      ) {
        await this.scheduleFailedSourceBlobUploadCleanup(source);
      }
      throw error;
    }
    const [updated] = await this.db
      .select({ version: sources.version })
      .from(sources)
      .where(
        and(eq(sources.userId, input.userId), eq(sources.id, input.sourceId)),
      )
      .limit(1);
    if (!updated)
      throw new Error(`Source ${input.sourceId} disappeared after upload`);
    return updated.version;
  }

  /**
   * Source erasure and object storage cannot share a transaction. Reserve the
   * deterministic object key before any put so tombstone owns a durable
   * coordination point even if this worker dies between database steps.
   */
  private async reserveSourceBlobUpload(
    source: SourcesInsert & { id: TypeId<"source"> },
    rootWriteFence?: { userId: string; source: SourceWriteFence },
    allowReplacement = false,
    contentHash?: string,
  ): Promise<BlobUploadReservation> {
    return withSourceWriteFence(
      this.db,
      this.sourceBlobUploadFences(source, rootWriteFence),
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(sourceBlobUploads)
          .where(
            and(
              eq(sourceBlobUploads.userId, source.userId),
              eq(sourceBlobUploads.sourceId, source.id),
            ),
          )
          .for("update")
          .limit(1);
        if (
          existing &&
          !(
            allowReplacement &&
            ["uploaded", "cleanup_pending", "cleanup_completed"].includes(
              existing.state,
            )
          )
        ) {
          throw new Error(
            `A blob upload reservation already exists for source ${source.id}`,
          );
        }
        if (contentHash !== undefined) {
          const [accepted] = await tx
            .select({ operationId: sourceIngestionOperations.operationId })
            .from(sourceIngestionOperations)
            .where(
              and(
                eq(sourceIngestionOperations.userId, source.userId),
                eq(sourceIngestionOperations.sourceId, source.id),
                eq(sourceIngestionOperations.contentHash, contentHash),
              ),
            )
            .limit(1);
          if (accepted) {
            throw new PartitionAccessError(
              "SOURCE_VERSION_CONFLICT",
              "Source revision was accepted concurrently; retry to reuse its receipt",
            );
          }
        }

        const updatedAt = new Date();
        if (existing) {
          await tx
            .update(sourceBlobUploads)
            .set({
              state: "reserved",
              updatedAt,
              uploadedAt: null,
              cleanupCompletedAt: null,
            })
            .where(
              and(
                eq(sourceBlobUploads.userId, source.userId),
                eq(sourceBlobUploads.sourceId, source.id),
                eq(sourceBlobUploads.state, existing.state),
              ),
            );
        } else {
          await tx.insert(sourceBlobUploads).values({
            userId: source.userId,
            sourceId: source.id,
            objectKey: sourceBlobObjectKey(source.userId, source.id),
            state: "reserved",
            updatedAt,
          });
        }
        return { previous: existing, updatedAt };
      },
    );
  }

  /** Marks a committed reservation as ready to own the external put. */
  private async beginSourceBlobUpload(
    source: SourcesInsert & { id: TypeId<"source"> },
    rootWriteFence?: { userId: string; source: SourceWriteFence },
  ): Promise<Date> {
    return withSourceWriteFence(
      this.db,
      this.sourceBlobUploadFences(source, rootWriteFence),
      async (tx) => {
        const [upload] = await tx
          .select({ state: sourceBlobUploads.state })
          .from(sourceBlobUploads)
          .where(
            and(
              eq(sourceBlobUploads.userId, source.userId),
              eq(sourceBlobUploads.sourceId, source.id),
            ),
          )
          .for("update")
          .limit(1);
        if (!upload || upload.state !== "reserved") {
          throw new PartitionAccessError(
            "SOURCE_TOMBSTONED",
            "Source blob upload was cancelled before bytes were sent",
          );
        }
        const updatedAt = new Date();
        await tx
          .update(sourceBlobUploads)
          .set({ state: "uploading", updatedAt })
          .where(
            and(
              eq(sourceBlobUploads.userId, source.userId),
              eq(sourceBlobUploads.sourceId, source.id),
              eq(sourceBlobUploads.state, "reserved"),
            ),
          );
        return updatedAt;
      },
    );
  }

  /**
   * Holds the source and reservation locks across the object-store call. A
   * tombstone therefore waits for this put's acknowledgement or durable unknown
   * receipt; if it wins first this method fails before sending bytes.
   */
  private async putSourceBlobWithFence(
    source: SourcesInsert & { id: TypeId<"source"> },
    fileBuffer: Buffer,
    contentType: string | undefined,
    rootWriteFence?: { userId: string; source: SourceWriteFence },
    revision?: {
      metadata: Metadata;
      parentSource: TypeId<"source"> | null;
      scope: Scope;
      lastIngestedAt: Date;
      status: SourcesInsert["status"];
      replaceDerivedLinks: boolean;
      operation?: { externalId: string; contentHash: string };
    },
    reservation?: { updatedAt: Date; onPutStarted: () => void },
  ): Promise<void> {
    // Resolve the bucket region and sign before taking database row locks.
    const signedUrl = await this.minioClient.presignedPutObject(
      this.bucket,
      sourceBlobObjectKey(source.userId, source.id),
      3600,
    );
    const outcome = await this.db.transaction(async (tx) => {
      const fences = this.sourceBlobUploadFences(source, rootWriteFence);
      const sourceIdentity = {
        userId: source.userId,
        sourceType: source.type,
        externalId: source.externalId,
      } satisfies SourceIdentity;
      await lockSourceIdentityGates(tx, [sourceIdentity]);
      const parentAttachments = revision?.parentSource
        ? [
            {
              userId: source.userId,
              sourceId: revision.parentSource,
              ...(source.partitionKey !== null &&
              source.partitionKey !== undefined
                ? { partitionKey: source.partitionKey }
                : {}),
            },
          ]
        : [];
      await lockSourceParentAttachmentGates(tx, parentAttachments);
      const sourceIds = [
        ...new Set(fences.sources.map((fence) => fence.sourceId)),
      ].sort();
      const lockedSources = await tx
        .select({
          id: sources.id,
          version: sources.version,
          deletedAt: sources.deletedAt,
          partitionKey: sources.partitionKey,
          type: sources.type,
          externalId: sources.externalId,
        })
        .from(sources)
        .where(
          and(
            eq(sources.userId, source.userId),
            inArray(sources.id, sourceIds),
          ),
        )
        .orderBy(sources.id)
        .for("update");
      if (
        lockedSources.length !== sourceIds.length ||
        lockedSources.some((locked) => locked.deletedAt !== null)
      ) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Source blob upload was cancelled before bytes were sent",
        );
      }
      const lockedSource = lockedSources.find(
        (locked) => locked.id === source.id,
      );
      if (
        !lockedSource ||
        lockedSource.partitionKey !== (source.partitionKey ?? null) ||
        lockedSource.type !== source.type ||
        lockedSource.externalId !== source.externalId
      ) {
        throw new PartitionAccessError(
          "SOURCE_VERSION_CONFLICT",
          "Source identity or partition changed before bytes were sent",
          lockedSource?.version,
        );
      }
      await assertSourceIdentitiesActive(tx, [sourceIdentity]);
      await assertLiveSourceParents(tx, parentAttachments);
      const tombstones = await tx
        .select({ sourceId: sourceTombstones.sourceId })
        .from(sourceTombstones)
        .where(
          and(
            eq(sourceTombstones.userId, source.userId),
            inArray(sourceTombstones.sourceId, sourceIds),
          ),
        );
      if (tombstones.length > 0) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Source blob upload was cancelled before bytes were sent",
        );
      }
      if (
        rootWriteFence?.userId !== undefined &&
        rootWriteFence.userId !== source.userId
      ) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Source upload root fence belongs to another user",
        );
      }
      if (rootWriteFence?.source.expectedSourceVersion !== undefined) {
        const root = lockedSources.find(
          (locked) => locked.id === rootWriteFence.source.sourceId,
        );
        if (
          !root ||
          root.version !== rootWriteFence.source.expectedSourceVersion
        ) {
          throw new PartitionAccessError(
            "SOURCE_VERSION_CONFLICT",
            "Source upload root changed before bytes were committed",
            root?.version,
          );
        }
      }
      const [upload] = await tx
        .select({
          state: sourceBlobUploads.state,
          updatedAt: sourceBlobUploads.updatedAt,
        })
        .from(sourceBlobUploads)
        .where(
          and(
            eq(sourceBlobUploads.userId, source.userId),
            eq(sourceBlobUploads.sourceId, source.id),
          ),
        )
        .for("update")
        .limit(1);
      if (
        !upload ||
        upload.state !== "uploading" ||
        (reservation &&
          upload.updatedAt.getTime() !== reservation.updatedAt.getTime())
      ) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Source blob upload was cancelled before bytes were sent",
        );
      }
      await this.blobUploadHooks.beforePut?.({
        userId: source.userId,
        sourceId: source.id,
        objectKey: sourceBlobObjectKey(source.userId, source.id),
      });
      try {
        reservation?.onPutStarted();
        await putSourceBlob(signedUrl, fileBuffer, this.blobUploadTimeoutMs);
      } catch (error: unknown) {
        if (!(error instanceof SourceBlobUploadTimeoutError)) throw error;
        // Socket cancellation cannot revoke a PUT already accepted remotely.
        // Commit this fence before releasing the source lock to deletion.
        await tx
          .update(sourceBlobUploads)
          .set({ state: "upload_unknown", updatedAt: new Date() })
          .where(
            and(
              eq(sourceBlobUploads.userId, source.userId),
              eq(sourceBlobUploads.sourceId, source.id),
            ),
          );
        await tx
          .update(sources)
          .set({ status: "failed" })
          .where(
            and(eq(sources.userId, source.userId), eq(sources.id, source.id)),
          );
        return error;
      }
      const [updatedSource] = await tx
        .update(sources)
        .set({
          status: revision?.status ?? "completed",
          ...(revision
            ? {
                metadata: revision.metadata,
                parentSource: revision.parentSource,
                scope: revision.scope,
                lastIngestedAt: revision.lastIngestedAt,
              }
            : {}),
          contentType,
          contentLength: fileBuffer.length,
        })
        .where(
          and(eq(sources.userId, source.userId), eq(sources.id, source.id)),
        )
        .returning({ id: sources.id, version: sources.version });
      if (!updatedSource) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Source disappeared while its blob upload was completing",
        );
      }
      if (revision?.replaceDerivedLinks) {
        await invalidateSourceExtractionRevision(tx, source.userId, source.id);
      }
      if (revision?.operation) {
        await tx.insert(sourceIngestionOperations).values({
          operationId: randomUUID(),
          userId: source.userId,
          sourceId: source.id,
          partitionKey: source.partitionKey ?? null,
          externalId: revision.operation.externalId,
          contentHash: revision.operation.contentHash,
          sourceVersion: updatedSource.version,
          status: "queued",
          stage: "content",
          attempt: 0,
        });
      }
      await tx
        .update(sourceBlobUploads)
        .set({
          state: "uploaded",
          uploadedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceBlobUploads.userId, source.userId),
            eq(sourceBlobUploads.sourceId, source.id),
            eq(sourceBlobUploads.state, "uploading"),
          ),
        );
      return undefined;
    });
    if (outcome) throw outcome;
  }

  /** No PUT started: restore only this reservation without deleting prior bytes. */
  private async cancelSourceBlobUploadBeforePut(
    source: SourcesInsert & { id: TypeId<"source"> },
    reservation: BlobUploadReservation,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ deletedAt: sources.deletedAt })
        .from(sources)
        .where(
          and(eq(sources.userId, source.userId), eq(sources.id, source.id)),
        )
        .for("update")
        .limit(1);
      if (!current || current.deletedAt !== null) return;
      const ownedReservation = and(
        eq(sourceBlobUploads.userId, source.userId),
        eq(sourceBlobUploads.sourceId, source.id),
        eq(sourceBlobUploads.updatedAt, reservation.updatedAt),
        inArray(sourceBlobUploads.state, ["reserved", "uploading"]),
      );
      if (reservation.previous) {
        await tx
          .update(sourceBlobUploads)
          .set({
            state: reservation.previous.state,
            updatedAt: reservation.previous.updatedAt,
            uploadedAt: reservation.previous.uploadedAt,
            cleanupCompletedAt: reservation.previous.cleanupCompletedAt,
          })
          .where(ownedReservation);
      } else {
        await tx.delete(sourceBlobUploads).where(ownedReservation);
      }
    });
  }

  /** Marks a failed or cancelled upload for durable physical cleanup. */
  private async scheduleFailedSourceBlobUploadCleanup(
    source: SourcesInsert & { id: TypeId<"source"> },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [lockedSource] = await tx
        .select({ deletedAt: sources.deletedAt })
        .from(sources)
        .where(
          and(eq(sources.userId, source.userId), eq(sources.id, source.id)),
        )
        .for("update")
        .limit(1);
      const [upload] = await tx
        .select({ state: sourceBlobUploads.state })
        .from(sourceBlobUploads)
        .where(
          and(
            eq(sourceBlobUploads.userId, source.userId),
            eq(sourceBlobUploads.sourceId, source.id),
          ),
        )
        .for("update")
        .limit(1);
      if (
        upload &&
        upload.state !== "cleanup_completed" &&
        upload.state !== "upload_unknown"
      ) {
        await tx
          .update(sourceBlobUploads)
          .set({ state: "cleanup_pending", updatedAt: new Date() })
          .where(
            and(
              eq(sourceBlobUploads.userId, source.userId),
              eq(sourceBlobUploads.sourceId, source.id),
            ),
          );
      }
      if (lockedSource && lockedSource.deletedAt === null) {
        await tx
          .update(sources)
          .set({ status: "failed" })
          .where(
            and(eq(sources.userId, source.userId), eq(sources.id, source.id)),
          );
      }
    });
  }

  private sourceBlobUploadFences(
    source: SourcesInsert & { id: TypeId<"source"> },
    rootWriteFence?: { userId: string; source: SourceWriteFence },
  ): {
    userId: string;
    partitionKey: ContextPartitionKey | undefined;
    sources: readonly SourceWriteFence[];
  } {
    return {
      userId: source.userId,
      partitionKey: source.partitionKey ?? undefined,
      sources: [
        ...(rootWriteFence ? [rootWriteFence.source] : []),
        { sourceId: source.id },
      ],
    };
  }

  /** Physical object deletion only; source lifecycle owns the SQL receipt. */
  async deleteRawBlobIfPresent(
    userId: string,
    sourceId: TypeId<"source">,
  ): Promise<void> {
    return this.deleteRawBlobObjectKeyIfPresent(
      sourceBlobObjectKey(userId, sourceId),
    );
  }

  /** Observes a completed object write without treating absence as terminal. */
  async rawBlobObjectKeyExists(objectKey: string): Promise<boolean> {
    try {
      await this.minioClient.statObject(this.bucket, objectKey);
      return true;
    } catch (error: unknown) {
      if (isMissingSourceBlobError(error)) return false;
      throw error;
    }
  }

  /** Deletes an opaque object key captured in a lifecycle receipt. */
  async deleteRawBlobObjectKeyIfPresent(objectKey: string): Promise<void> {
    if (!(await this.minioClient.bucketExists(this.bucket))) return;
    try {
      await new Promise<void>((resolve, reject) => {
        this.minioClient.removeObject(this.bucket, objectKey, (error) =>
          error ? reject(error) : resolve(),
        );
      });
    } catch (error) {
      if (isMissingSourceBlobError(error)) return;
      throw error;
    }
  }

  /** Fetch raw payloads for given sourceIds (inline or blob) */
  async fetchRaw(
    userId: string,
    sourceIds: TypeId<"source">[],
  ): Promise<RawResult[]> {
    const rows = await this.db.query.sources.findMany({
      where: (src, { and, eq, inArray }) =>
        and(
          eq(src.userId, userId),
          inArray(src.id, sourceIds),
          isNull(src.deletedAt),
        ),
    });
    const results: RawResult[] = [];

    for (const row of rows) {
      const meta = sourceMetadataSchema.parse(row.metadata ?? {});
      if (meta.rawContent !== undefined) {
        results.push({
          kind: "inline",
          sourceId: row.id,
          content: meta.rawContent,
        });
      } else if (row.contentLength === null && row.contentType === null) {
        continue;
      } else {
        const key = sourceBlobObjectKey(userId, row.id);
        let stream: Readable;
        try {
          stream = (await this.minioClient.getObject(
            this.bucket,
            key,
          )) as Readable;
        } catch (error) {
          if (isMissingSourceBlobError(error)) {
            logEvent("source.blob.missing", {
              userId,
              sourceId: row.id,
              key,
            });
            continue;
          }
          throw error;
        }
        const buffer = await this.streamToBuffer(stream);
        results.push({
          kind: "blob",
          sourceId: row.id,
          buffer,
          contentType: row.contentType ?? "application/octet-stream",
        });
      }
    }

    return results;
  }

  async listBlobSourceIds(
    userId: string,
  ): Promise<ReadonlySet<TypeId<"source">>> {
    const bucketExists = await this.minioClient.bucketExists(this.bucket);
    if (!bucketExists) {
      throw new Error(`Source bucket ${this.bucket} does not exist`);
    }

    const prefix = sourceObjectPrefix(userId);
    const objectStream = this.minioClient.listObjectsV2(
      this.bucket,
      prefix,
      true,
    );

    return new Promise((resolve, reject) => {
      const sourceIds = new Set<TypeId<"source">>();
      objectStream.on("data", (item) => {
        if (!item.name) return;
        const sourceId = parseSourceIdFromObjectName(userId, item.name);
        if (sourceId) sourceIds.add(sourceId);
      });
      objectStream.on("error", reject);
      objectStream.on("end", () => resolve(sourceIds));
    });
  }

  /** Fetch textual payload, decoding blob as utf-8 */
  async fetchText(userId: string, sourceId: TypeId<"source">): Promise<string> {
    const [res] = await this.fetchRaw(userId, [sourceId]);
    if (!res) throw new Error(`Source ${sourceId} not found`);
    return res.kind === "inline" ? res.content : res.buffer.toString("utf-8");
  }

  /** Helper to read a Readable stream into a Buffer */
  private streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk) => chunks.push(chunk as Buffer));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
  }
}

/** Singleton instance configured from env */
export const sourceService = new SourceService(
  db,
  new MinioClient({
    endPoint: env.MINIO_ENDPOINT,
    port: env.MINIO_PORT!,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
  }),
  env.SOURCES_BUCKET,
);

/**
 * Return the per-user synthetic source used for system-authored claims.
 */
export async function ensureSystemSource(
  database: DrizzleDB,
  userId: string,
  type: Extract<SourceType, "manual" | "legacy_migration">,
  partitionKey?: ContextPartitionKey,
): Promise<TypeId<"source">> {
  await preparePartitionWrite(database, userId, partitionKey);
  const externalId = `${type}:${userId}${partitionKey === undefined ? "" : `:${partitionKey}`}`;
  const [inserted] = await database
    .insert(sources)
    .values({
      userId,
      partitionKey,
      type,
      externalId,
      status: "completed",
      scope: "personal",
      lastIngestedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [sources.userId, sources.type, sources.externalId],
    })
    .returning({ id: sources.id });

  if (inserted) return inserted.id;

  const [existing] = await database
    .select({ id: sources.id, deletedAt: sources.deletedAt })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.type, type),
        eq(sources.externalId, externalId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new Error(`Failed to ensure ${type} source for user ${userId}`);
  }

  const [tombstone] = await database
    .select({ sourceId: sourceTombstones.sourceId })
    .from(sourceTombstones)
    .where(
      and(
        eq(sourceTombstones.userId, userId),
        eq(sourceTombstones.sourceId, existing.id),
      ),
    )
    .limit(1);
  if (existing.deletedAt !== null || tombstone) {
    throw new PartitionAccessError(
      "SOURCE_TOMBSTONED",
      `A tombstoned ${type} source cannot be reused`,
    );
  }

  return existing.id;
}
