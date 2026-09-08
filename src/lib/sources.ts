import { and, eq, inArray, isNull } from "drizzle-orm";
import { Client as MinioClient } from "minio";
import { Readable } from "stream";
import { z } from "zod";
import db, { type DrizzleDB } from "~/db";
import {
  sourceBlobUploads,
  sourceTombstones,
  sources,
  SourcesInsert,
} from "~/db/schema";
import { logEvent } from "~/lib/observability/log";
import {
  PartitionAccessError,
  assertLiveSourceParents,
  lockSourceParentAttachmentGates,
  preparePartitionWrite,
  type SourceWriteFence,
  withSourceWriteFence,
} from "~/lib/partition-access";
import type { ContextPartitionKey } from "~/lib/schemas/partition";
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
  })
  .catchall(z.unknown());
type Metadata = z.infer<typeof sourceMetadataSchema>;

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
        ? [{ userId: input.userId, sourceId: input.parentId }]
        : [],
    );
    const insertWithParentAttachmentFence = async (
      database: DrizzleDB,
      gatesAlreadyHeld = false,
    ) => {
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
            beforeSourceLocks: (tx) =>
              lockSourceParentAttachmentGates(tx, parentAttachments),
          },
          (tx) => insertWithParentAttachmentFence(tx, true),
        )
      : parentAttachments.length > 0
        ? await this.db.transaction((tx) => insertWithParentAttachmentFence(tx))
        : await insertSourceRows(this.db);

    const writePayload = <T>(write: (database: DrizzleDB) => Promise<T>) =>
      rootWriteFence
        ? withSourceWriteFence(
            this.db,
            {
              userId: rootWriteFence.userId,
              sources: [rootWriteFence.source],
            },
            (tx) => write(tx),
          )
        : write(this.db);

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
      // Inline payload if small enough or content provided
      if (
        input.content !== undefined ||
        (input.fileBuffer && input.fileBuffer.length <= this.inlineThreshold)
      ) {
        const existingMeta = sourceMetadataSchema.parse(row.metadata);
        const updatedMeta: Metadata = {
          ...existingMeta,
          rawContent: input.content ?? input.fileBuffer!.toString("utf-8"),
        };
        try {
          await writePayload((database) =>
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
          // A cancelled request can have reached storage. Leave its reservation
          // for stale-upload recovery instead of claiming an immediate outcome.
          if (!(err instanceof SourceBlobUploadTimeoutError)) {
            await this.scheduleFailedSourceBlobUploadCleanup(row);
          }
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
      // no payload
      else {
        try {
          await writePayload((database) =>
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

  /**
   * Source erasure and object storage cannot share a transaction. Reserve the
   * deterministic object key before any put so tombstone owns a durable
   * coordination point even if this worker dies between database steps.
   */
  private async reserveSourceBlobUpload(
    source: SourcesInsert & { id: TypeId<"source"> },
    rootWriteFence?: { userId: string; source: SourceWriteFence },
  ): Promise<void> {
    await withSourceWriteFence(
      this.db,
      this.sourceBlobUploadFences(source, rootWriteFence),
      async (tx) => {
        const [existing] = await tx
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
        if (existing) {
          throw new Error(
            `A blob upload reservation already exists for source ${source.id}`,
          );
        }
        await tx.insert(sourceBlobUploads).values({
          userId: source.userId,
          sourceId: source.id,
          objectKey: sourceBlobObjectKey(source.userId, source.id),
          state: "reserved",
        });
      },
    );
  }

  /** Marks a committed reservation as ready to own the external put. */
  private async beginSourceBlobUpload(
    source: SourcesInsert & { id: TypeId<"source"> },
    rootWriteFence?: { userId: string; source: SourceWriteFence },
  ): Promise<void> {
    await withSourceWriteFence(
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
        await tx
          .update(sourceBlobUploads)
          .set({ state: "uploading", updatedAt: new Date() })
          .where(
            and(
              eq(sourceBlobUploads.userId, source.userId),
              eq(sourceBlobUploads.sourceId, source.id),
              eq(sourceBlobUploads.state, "reserved"),
            ),
          );
      },
    );
  }

  /**
   * Holds the source and reservation locks across the object-store call. A
   * tombstone therefore waits for this put, then switches the reservation to
   * cleanup; if it wins first this method fails before sending bytes.
   */
  private async putSourceBlobWithFence(
    source: SourcesInsert & { id: TypeId<"source"> },
    fileBuffer: Buffer,
    contentType: string | undefined,
    rootWriteFence?: { userId: string; source: SourceWriteFence },
  ): Promise<void> {
    // Resolve the bucket region and sign before taking database row locks.
    const signedUrl = await this.minioClient.presignedPutObject(
      this.bucket,
      sourceBlobObjectKey(source.userId, source.id),
      3600,
    );
    await this.db.transaction(async (tx) => {
      const fences = this.sourceBlobUploadFences(source, rootWriteFence);
      const sourceIds = [
        ...new Set(fences.sources.map((fence) => fence.sourceId)),
      ].sort();
      const lockedSources = await tx
        .select({
          id: sources.id,
          version: sources.version,
          deletedAt: sources.deletedAt,
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
      if (!upload || upload.state !== "uploading") {
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
      await putSourceBlob(signedUrl, fileBuffer, this.blobUploadTimeoutMs);
      const [updatedSource] = await tx
        .update(sources)
        .set({
          status: "completed",
          contentType,
          contentLength: fileBuffer.length,
        })
        .where(
          and(eq(sources.userId, source.userId), eq(sources.id, source.id)),
        )
        .returning({ id: sources.id });
      if (!updatedSource) {
        throw new PartitionAccessError(
          "SOURCE_TOMBSTONED",
          "Source disappeared while its blob upload was completing",
        );
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
      if (upload && upload.state !== "cleanup_completed") {
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
  ): { userId: string; sources: readonly SourceWriteFence[] } {
    return {
      userId: source.userId,
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
