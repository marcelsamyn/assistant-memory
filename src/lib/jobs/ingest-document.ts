import { extractGraph } from "../extract-graph";
import { ensureSourceNode } from "../ingestion/ensure-source-node";
import { ensureUser } from "../ingestion/ensure-user";
import { sourceService } from "../sources";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { DrizzleDB } from "~/db";
import { nodes, sourceLinks, sources } from "~/db/schema";
import { NodeTypeEnum, ScopeEnum } from "~/types/graph";

export const IngestDocumentJobInputSchema = z.object({
  userId: z.string(),
  documentId: z.string(),
  content: z.string(),
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

  // Insert the document as a single source
  const { successes: insertedSourceInternalIds, failures } =
    await sourceService.insertMany([
      {
        userId,
        sourceType: "document",
        externalId: documentId,
        scope,
        timestamp,
        content, // Store content directly for documents
        metadata: {
          ...(author !== undefined && { author }),
          ...(title !== undefined && { title }),
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

  // Ensure a graph node exists for this document source
  const documentNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId,
    timestamp,
    nodeType: NodeTypeEnum.enum.Document,
  });

  // Extract graph from the document content
  await extractGraph({
    userId,
    sourceType: "document",
    sourceId,
    statedAt: timestamp,
    linkedNodeId: documentNodeId,
    sourceRefs: [{ externalId: documentId, sourceId, statedAt: timestamp }],
    content, // Pass the raw document content for graph extraction
  });

  console.log(
    `Successfully ingested and processed document ${documentId} for user ${userId}`,
  );
}
