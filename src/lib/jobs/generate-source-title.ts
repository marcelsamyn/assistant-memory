import { and, eq, sql } from "drizzle-orm";
import { DrizzleDB } from "~/db";
import { sources } from "~/db/schema";
import { sourceMetadataSchema, sourceService } from "~/lib/sources";
import { deriveTitle } from "~/lib/sources-read";
import { generateTitleFromContent } from "~/lib/source-title";
import { type TypeId } from "~/types/typeid";

const PREVIEW_MAX_CHARS = 2000;
const MAX_CHILDREN = 40;

/**
 * Best-effort content preview for titling. Documents use their own inline /
 * text-blob body; containers (conversation, meeting_transcript,
 * external_conversation) have no body of their own, so we concatenate their
 * child sources' `rawContent`.
 */
async function gatherContentPreview(
  db: DrizzleDB,
  userId: string,
  sourceId: TypeId<"source">,
): Promise<string | null> {
  const [own] = await sourceService.fetchRaw(userId, [sourceId]);
  if (own?.kind === "inline") return own.content.slice(0, PREVIEW_MAX_CHARS);
  if (own?.kind === "blob" && own.contentType.startsWith("text/")) {
    return own.buffer.toString("utf-8").slice(0, PREVIEW_MAX_CHARS);
  }

  const children = await db.query.sources.findMany({
    where: (s, { and: a, eq: e }) =>
      a(e(s.userId, userId), e(s.parentSource, sourceId)),
    orderBy: (s, { asc: ascFn }) => ascFn(s.createdAt),
    limit: MAX_CHILDREN,
  });
  const parts: string[] = [];
  for (const child of children) {
    const meta = sourceMetadataSchema.safeParse(child.metadata ?? {});
    const raw = meta.success ? meta.data.rawContent : undefined;
    if (typeof raw === "string" && raw.trim().length > 0) {
      parts.push(raw.trim());
      if (parts.join("\n").length >= PREVIEW_MAX_CHARS) break;
    }
  }
  const joined = parts.join("\n").slice(0, PREVIEW_MAX_CHARS);
  return joined.length > 0 ? joined : null;
}

/**
 * Generate and persist a title for a source that lacks one. Idempotent: a
 * no-op when the source already has a title (so re-enqueues and user-supplied
 * titles are safe). The UPDATE guards on the title still being absent.
 */
export async function generateSourceTitle(
  db: DrizzleDB,
  { userId, sourceId }: { userId: string; sourceId: TypeId<"source"> },
): Promise<{ generated: boolean }> {
  const [row] = await db
    .select({ type: sources.type, metadata: sources.metadata })
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1);
  if (!row) return { generated: false };
  if (deriveTitle(row.metadata)) return { generated: false };

  const preview = await gatherContentPreview(db, userId, sourceId);
  if (!preview) return { generated: false };

  const title = await generateTitleFromContent({
    userId,
    type: row.type,
    contentPreview: preview,
  });
  if (!title) return { generated: false };

  await db
    .update(sources)
    .set({
      metadata: sql`COALESCE(${sources.metadata}, '{}'::jsonb) || jsonb_build_object('title', ${title}::text)`,
    })
    .where(
      and(
        eq(sources.id, sourceId),
        eq(sources.userId, userId),
        sql`NOT (COALESCE(${sources.metadata}, '{}'::jsonb) ? 'title')`,
      ),
    );
  return { generated: true };
}
