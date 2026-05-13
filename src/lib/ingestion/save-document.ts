/**
 * Orchestrator for `POST /ingest/document`.
 *
 * Source-row creation happens here (synchronously, in the route call) so the
 * caller gets a deterministic `sourceId` back immediately and can hand it to
 * project auto-attach flows. Heavy work — HTML→markdown conversion and graph
 * extraction — runs in the queued `ingest-document` worker.
 *
 * On `updateExisting`, the prior nodes/sources for this externalId are
 * cascaded away here too, so the worker only ever sees a freshly-inserted
 * row to extract from.
 */
import { batchQueue } from "../queues";
import {
  IngestDocumentRequest,
  IngestDocumentResponse,
} from "../schemas/ingest-document-request";
import { sourceService } from "../sources";
import { ensureUser } from "./ensure-user";
import { and, eq, inArray } from "drizzle-orm";
import { createError } from "h3";
import db from "~/db";
import { nodes, sourceLinks, sources } from "~/db/schema";
import type { TypeId } from "~/types/typeid";

/**
 * Queue a document ingestion job.
 */
export async function saveMemory(
  req: IngestDocumentRequest,
): Promise<IngestDocumentResponse> {
  const { userId, document, updateExisting = false } = req;

  await ensureUser(db, userId);

  if (updateExisting) {
    // Cascade: delete graph nodes derived from any prior source row carrying
    // this externalId, then drop the source rows themselves. The worker used
    // to do this, but pre-creating the source row in the route forces this
    // step to live alongside the insert so re-ingests stay atomic.
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
                      eq(sources.externalId, document.id),
                    ),
                  ),
              ),
            ),
        ),
      ),
    );
    await db
      .delete(sources)
      .where(
        and(
          eq(sources.userId, userId),
          eq(sources.type, "document"),
          eq(sources.externalId, document.id),
        ),
      );
  }

  const timestamp = document.timestamp ?? new Date();

  const { successes, failures } = await sourceService.insertMany([
    {
      userId,
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
  if (successes.length > 0) {
    sourceId = successes[0]!;
  } else {
    // Conflict path: the row already existed and updateExisting was false.
    // Look up the existing sourceId so the caller can still auto-attach,
    // and skip the worker (no extraction work to do).
    const [existing] = await db
      .select({ id: sources.id })
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

    return {
      message: "Document already ingested; reusing existing source",
      jobId: document.id,
      sourceId: existing.id,
    };
  }

  await batchQueue.add("ingest-document", {
    userId,
    sourceId,
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
