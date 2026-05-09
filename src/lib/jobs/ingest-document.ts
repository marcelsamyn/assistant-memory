import { convertToMarkdown } from "../converters/markitdown";
import { extractDocumentGraph } from "../ingestion/extract-document-graph";
import { ensureUser } from "../ingestion/ensure-user";
import { sourceService } from "../sources";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { nodes, sourceLinks, sources } from "~/db/schema";
import { ScopeEnum } from "~/types/graph";

export const IngestDocumentJobInputSchema = z.object({
  userId: z.string(),
  documentId: z.string(),
  content: z.string(),
  contentType: z.enum(["markdown", "text", "html"]).optional().default("markdown"),
  timestamp: z.string().datetime().pipe(z.coerce.date()), // Handled by route, always a Date here
  scope: ScopeEnum.optional().default("personal"),
  updateExisting: z.boolean().optional().default(false),
  author: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
});

export type IngestDocumentJobInput = z.infer<
  typeof IngestDocumentJobInputSchema
>;

interface IngestDocumentParams extends IngestDocumentJobInput {
  db: DrizzleDB;
}

export async function ingestDocument({
  db,
  userId,
  documentId,
  content,
  contentType,
  timestamp,
  scope,
  updateExisting,
  author,
  title,
}: IngestDocumentParams): Promise<void> {
  await ensureUser(db, userId);

  if (updateExisting) {
    // Delete all nodes linked to sources for this document in a single query
    await db.delete(nodes).where(
      and(
        eq(nodes.userId, userId),
        inArray(
          nodes.id,
          db
            .select({ nodeId: sourceLinks.nodeId })
            .from(sourceLinks)
            .where(
              inArray(
                sourceLinks.sourceId,
                db
                  .select({ id: sources.id })
                  .from(sources)
                  .where(
                    and(
                      eq(sources.userId, userId),
                      eq(sources.type, "document"),
                      eq(sources.externalId, documentId),
                    ),
                  ),
              ),
            ),
        ),
      ),
    );

    // Delete all sources for this document in a single query
    await db
      .delete(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.type, "document"),
          eq(sources.externalId, documentId),
        ),
      );
  }

  // HTML inputs are converted to markdown via the same sidecar that file
  // uploads use, so JavaScript/CSS/boilerplate is stripped before the LLM
  // ever sees the content. Conversion failures bubble up so BullMQ retries.
  let resolvedContent = content;
  let resolvedTitle = title;
  if (contentType === "html") {
    const converted = await convertToMarkdown({
      buffer: Buffer.from(content, "utf-8"),
      filename: `${documentId}.html`,
      mimeType: "text/html",
    });
    resolvedContent = converted.markdown;
    // Promote converter-derived title only when caller didn't supply one.
    if (resolvedTitle === undefined && converted.title !== null) {
      resolvedTitle = converted.title;
    }
  }

  // Insert the document as a single source
  const { successes: insertedSourceInternalIds, failures } =
    await sourceService.insertMany([
      {
        userId,
        sourceType: "document",
        externalId: documentId,
        scope,
        timestamp,
        content: resolvedContent, // Store post-conversion text directly
        metadata: {
          ...(author !== undefined && { author }),
          ...(resolvedTitle !== undefined && { title: resolvedTitle }),
        },
      },
    ]);

  if (failures.length > 0) {
    console.warn(
      `Failed to insert source for document ${documentId}, user ${userId}:`,
      failures,
    );
    // Depending on requirements, you might want to throw an error here
    // or implement a retry mechanism if the failure is transient.
  }

  // If no new source was inserted (e.g., it already existed and onConflictDoNothing was triggered),
  // or if insertion failed, we can exit early.
  if (insertedSourceInternalIds.length === 0) {
    console.log(
      `Document ${documentId} for user ${userId} already ingested or failed to insert. Skipping graph extraction.`,
    );
    return;
  }

  const sourceId = insertedSourceInternalIds[0]!;

  await extractDocumentGraph({
    db,
    userId,
    sourceId,
    externalId: documentId,
    content: resolvedContent,
    timestamp,
    logLabel: resolvedTitle ?? documentId,
    ...(resolvedTitle !== undefined && { title: resolvedTitle }),
    ...(author !== undefined && { author }),
  });

  console.log(
    `Successfully ingested and processed document ${documentId} for user ${userId}`,
  );
}
