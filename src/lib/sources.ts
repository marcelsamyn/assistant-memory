import { and, eq } from "drizzle-orm";
import { Client as MinioClient } from "minio";
import { Readable } from "stream";
import { z } from "zod";
import db, { type DrizzleDB } from "~/db";
import { sources, SourcesInsert } from "~/db/schema";
import { Scope, SourceType } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import { env } from "~/utils/env";

const metadataSchema = z
  .object({
    rawContent: z.string().optional(),
    /** Reference attribution surfaced via NodeCard.reference for reference-scope sources. */
    author: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  })
  .catchall(z.unknown());
type Metadata = z.infer<typeof metadataSchema>;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Discriminated union of inline vs blob payload */
export type RawResult =
  | { kind: "inline"; sourceId: string; content: string }
  | { kind: "blob"; sourceId: string; buffer: Buffer; contentType: string };

/** Input for creating a source */
export interface SourceCreateInput {
  userId: string;
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
  async insertMany(inputs: SourceCreateInput[]): Promise<{
    successes: TypeId<"source">[];
    failures: Array<{ sourceId?: TypeId<"source">; reason: string }>;
  }> {
    const successes: TypeId<"source">[] = [];
    const failures: Array<{ sourceId?: TypeId<"source">; reason: string }> = [];

    // 1. Bulk insert initial source rows with status pending
    const insertRows = inputs.map(
      (input): SourcesInsert => ({
        userId: input.userId,
        type: input.sourceType,
        externalId: input.externalId,
        parentSource: input.parentId,
        scope: input.scope ?? "personal",
        metadata: metadataSchema.parse(input.metadata ?? {}),
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

    const inserted = await this.db
      .insert(sources)
      .values(insertRows)
      .onConflictDoNothing({
        target: [sources.userId, sources.type, sources.externalId],
      })
      .returning();

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
      const key = `${input.userId}/${row.id}`;

      // Inline payload if small enough or content provided
      if (
        input.content !== undefined ||
        (input.fileBuffer && input.fileBuffer.length <= this.inlineThreshold)
      ) {
        const existingMeta = metadataSchema.parse(row.metadata);
        const updatedMeta: Metadata = {
          ...existingMeta,
          rawContent: input.content ?? input.fileBuffer!.toString("utf-8"),
        };
        try {
          await this.db
            .update(sources)
            .set({ metadata: updatedMeta, status: "completed" })
            .where(eq(sources.id, row.id));
          successes.push(row.id);
        } catch (err: unknown) {
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
      // Blob payload
      else if (input.fileBuffer) {
        try {
          await new Promise<void>((resolve, reject) => {
            this.minioClient.putObject(
              this.bucket,
              key,
              input.fileBuffer!,
              input.fileBuffer!.length,
              (err) => (err ? reject(err) : resolve()),
            );
          });
          await this.db
            .update(sources)
            .set({
              status: "completed" as const,
              contentType: input.contentType,
              contentLength: input.fileBuffer!.length,
            })
            .where(eq(sources.id, row.id));
          successes.push(row.id);
        } catch (err: unknown) {
          await this.db
            .update(sources)
            .set({ status: "failed" as const })
            .where(eq(sources.id, row.id));
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
      // no payload
      else {
        try {
          await this.db
            .update(sources)
            .set({ status: "completed" as const })
            .where(eq(sources.id, row.id));
          successes.push(row.id);
        } catch (err: unknown) {
          failures.push({ sourceId: row.id, reason: toErrorMessage(err) });
        }
      }
    }

    return { successes, failures };
  }

  /** Hard delete a source: remove blob then drop the DB row */
  async deleteHard(userId: string, sourceId: TypeId<"source">): Promise<void> {
    await this.ensureBucket();
    const key = `${userId}/${sourceId}`;
    // delete blob, ignore errors
    try {
      await new Promise<void>((resolve, reject) => {
        this.minioClient.removeObject(this.bucket, key, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch {
      // ignore missing blob
    }
    await this.db
      .delete(sources)
      .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)));
  }

  /** Fetch raw payloads for given sourceIds (inline or blob) */
  async fetchRaw(
    userId: string,
    sourceIds: TypeId<"source">[],
  ): Promise<RawResult[]> {
    const rows = await this.db.query.sources.findMany({
      where: (src, { and, eq, inArray }) =>
        and(eq(src.userId, userId), inArray(src.id, sourceIds)),
    });
    const results: RawResult[] = [];
    await this.ensureBucket();

    for (const row of rows) {
      const meta = metadataSchema.parse(row.metadata ?? {});
      if (meta.rawContent) {
        results.push({
          kind: "inline",
          sourceId: row.id,
          content: meta.rawContent,
        });
      } else {
        const key = `${userId}/${row.id}`;
        const stream = await this.minioClient.getObject(this.bucket, key);
        const buffer = await this.streamToBuffer(stream as Readable);
        results.push({
          kind: "blob",
          sourceId: row.id,
          buffer,
          contentType: row.contentType!,
        });
      }
    }

    return results;
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
): Promise<TypeId<"source">> {
  const externalId = `${type}:${userId}`;
  const [inserted] = await database
    .insert(sources)
    .values({
      userId,
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
    .select({ id: sources.id })
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

  return existing.id;
}
