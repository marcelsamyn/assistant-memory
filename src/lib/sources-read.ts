/**
 * Read-side helpers for the source-management API. Kept separate from
 * `sources.ts` (which owns the SourceService write/blob path) so the
 * picker/listing endpoints don't drag in the MinIO client.
 */
import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { sourceLinks, sources } from "~/db/schema";
import {
  type SourceListableType,
  sourceListableTypeEnum,
  type SourceSummary,
} from "~/lib/schemas/sources";
import { sourceMetadataSchema } from "~/lib/sources";
import type { TypeId } from "~/types/typeid";

const LISTABLE_TYPES: readonly SourceListableType[] =
  sourceListableTypeEnum.options;

interface ListCursor {
  /** ISO ordering field — `lastIngestedAt` falling back to `createdAt`. */
  o: string;
  /** Source id — tiebreaker so the keyset is total. */
  i: string;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string): ListCursor | null {
  try {
    const decoded = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ListCursor>;
    if (typeof decoded.o !== "string" || typeof decoded.i !== "string") {
      return null;
    }
    return { o: decoded.o, i: decoded.i };
  } catch {
    return null;
  }
}

function deriveTitle(metadata: unknown): string | null {
  const parsed = sourceMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) return null;
  return parsed.data.title ?? null;
}

interface ListParams {
  db: DrizzleDB;
  userId: string;
  type: SourceListableType | undefined;
  limit: number;
  cursor: string | undefined;
}

export async function listSourcesPage(params: ListParams): Promise<{
  sources: SourceSummary[];
  nextCursor: string | null;
}> {
  const { db, userId, limit } = params;
  const typeFilter = params.type
    ? [params.type]
    : (LISTABLE_TYPES as SourceListableType[]);

  const decoded = params.cursor ? decodeCursor(params.cursor) : null;

  // Order by lastIngestedAt (fall back to createdAt) DESC, then id DESC.
  const orderExpr = sql`COALESCE(${sources.lastIngestedAt}, ${sources.createdAt})`;

  const whereClauses = [
    eq(sources.userId, userId),
    isNull(sources.deletedAt),
    inArray(sources.type, typeFilter),
  ];

  if (decoded) {
    // Keyset: rows strictly older than the cursor, or same instant with
    // a smaller id. Cast through sql to keep parity with the order key.
    whereClauses.push(
      or(
        sql`COALESCE(${sources.lastIngestedAt}, ${sources.createdAt}) < ${decoded.o}::timestamptz`,
        and(
          sql`COALESCE(${sources.lastIngestedAt}, ${sources.createdAt}) = ${decoded.o}::timestamptz`,
          lt(sources.id, decoded.i as TypeId<"source">),
        ),
      )!,
    );
  }

  const rows = await db
    .select({
      id: sources.id,
      type: sources.type,
      status: sources.status,
      scope: sources.scope,
      metadata: sources.metadata,
      lastIngestedAt: sources.lastIngestedAt,
      createdAt: sources.createdAt,
      orderKey: orderExpr.as("order_key"),
      nodeCount: count(sourceLinks.id).as("node_count"),
    })
    .from(sources)
    .leftJoin(sourceLinks, eq(sourceLinks.sourceId, sources.id))
    .where(and(...whereClauses))
    .groupBy(sources.id)
    .orderBy(desc(orderExpr), desc(sources.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const summaries: SourceSummary[] = page.map((row) => ({
    sourceId: row.id,
    type: row.type as SourceListableType,
    title: deriveTitle(row.metadata),
    status: row.status ?? "pending",
    scope: row.scope,
    ingestedAt: row.lastIngestedAt ?? row.createdAt,
    nodeCount: Number(row.nodeCount),
  }));

  let nextCursor: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1]!;
    const orderTs = (last.lastIngestedAt ?? last.createdAt).toISOString();
    nextCursor = encodeCursor({ o: orderTs, i: last.id });
  }

  return { sources: summaries, nextCursor };
}

export async function getSourceSummary(
  db: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<SourceSummary | null> {
  const [row] = await db
    .select({
      id: sources.id,
      type: sources.type,
      status: sources.status,
      scope: sources.scope,
      metadata: sources.metadata,
      lastIngestedAt: sources.lastIngestedAt,
      createdAt: sources.createdAt,
      nodeCount: count(sourceLinks.id).as("node_count"),
    })
    .from(sources)
    .leftJoin(sourceLinks, eq(sourceLinks.sourceId, sources.id))
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.userId, userId),
        isNull(sources.deletedAt),
      ),
    )
    .groupBy(sources.id)
    .limit(1);

  if (!row) return null;
  if (!LISTABLE_TYPES.includes(row.type as SourceListableType)) return null;

  return {
    sourceId: row.id,
    type: row.type as SourceListableType,
    title: deriveTitle(row.metadata),
    status: row.status ?? "pending",
    scope: row.scope,
    ingestedAt: row.lastIngestedAt ?? row.createdAt,
    nodeCount: Number(row.nodeCount),
  };
}
