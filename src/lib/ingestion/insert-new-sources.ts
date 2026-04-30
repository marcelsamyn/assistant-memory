import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { sourceService, type SourceCreateInput } from "~/lib/sources";
import { Scope, SourceType } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import { getSourceServiceOverride } from "~/utils/test-overrides";

export interface SourceInput {
  externalId: string;
  timestamp: Date;
  content?: string;
  fileBuffer?: Buffer;
  contentType?: string;
  metadata?: SourceCreateInput["metadata"];
}

export interface InsertedSourceRef {
  externalId: string;
  sourceId: TypeId<"source">;
  statedAt?: Date | undefined;
}

export async function insertNewSources(params: {
  db: DrizzleDB;
  userId: string;
  parentSourceType: SourceType;
  parentSourceId: string;
  childSourceType: SourceType;
  scope?: Scope;
  childSources: SourceInput[];
}): Promise<{
  sourceId: TypeId<"source">;
  newSourceSourceIds: string[];
  sourceRefs: InsertedSourceRef[];
}> {
  const {
    db,
    userId,
    parentSourceType,
    parentSourceId,
    childSourceType,
    scope = "personal",
    childSources,
  } = params;

  // Upsert parent source
  const [parentSource] = await db
    .insert(sources)
    .values({
      userId,
      type: parentSourceType,
      externalId: parentSourceId,
      scope,
      lastIngestedAt: new Date(),
    })
    .onConflictDoUpdate({
      set: { lastIngestedAt: new Date() },
      target: [sources.userId, sources.type, sources.externalId],
    })
    .returning();

  if (!parentSource) {
    throw new Error("Failed to upsert parent source");
  }

  // Map to SourceService inputs
  const childInputs: SourceCreateInput[] = childSources.map((cs) => {
    const input: SourceCreateInput = {
      userId,
      sourceType: childSourceType,
      externalId: cs.externalId,
      parentId: parentSource.id,
      scope,
      timestamp: cs.timestamp,
    };
    if (cs.metadata !== undefined) input.metadata = cs.metadata;
    if (cs.content !== undefined) input.content = cs.content;
    if (cs.fileBuffer !== undefined) input.fileBuffer = cs.fileBuffer;
    if (cs.contentType !== undefined) input.contentType = cs.contentType;
    return input;
  });

  // Delegate insertion & storage. Eval harness can swap in a SQL-only stub
  // via `setSourceServiceOverride` so transcript ingestion runs without MinIO.
  const service = getSourceServiceOverride() ?? sourceService;
  const { successes: newInternalIds, failures } =
    await service.insertMany(childInputs);
  if (failures.length) {
    console.warn("Some sources failed to archive:", failures);
  }

  // Fetch external IDs for inserted sources
  const insertedRows = await db.query.sources.findMany({
    where: (src, { inArray }) => inArray(src.id, newInternalIds),
  });
  const newSourceSourceIds = insertedRows.map((r) => r.externalId);
  const sourceRefs = insertedRows.map((row) => ({
    externalId: row.externalId,
    sourceId: row.id,
    ...(row.lastIngestedAt !== null ? { statedAt: row.lastIngestedAt } : {}),
  }));

  return { sourceId: parentSource.id, newSourceSourceIds, sourceRefs };
}
