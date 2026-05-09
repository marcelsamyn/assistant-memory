/**
 * Shared post-content extraction step used by every "document-shaped"
 * ingestion path (direct text via `/ingest/document`, file uploads via
 * `/ingest/file`). Wraps `ensureSourceNode` + `runChunkedExtraction` so the
 * two job workers stay thin adapters that only differ in how they obtain
 * the markdown content for the source.
 */
import { runChunkedExtraction } from "./chunked-extract";
import { ensureSourceNode } from "./ensure-source-node";
import { DrizzleDB } from "~/db";
import { NodeTypeEnum } from "~/types/graph";
import { TypeId } from "~/types/typeid";

interface ExtractDocumentGraphParams {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  externalId: string;
  /** Markdown (or markdown-equivalent plain text) content to extract from. */
  content: string;
  /** Source timestamp — used as `statedAt` and to anchor the Document node. */
  timestamp: Date;
  /** Identifier shown in extractor log lines (e.g. filename or doc id). */
  logLabel: string;
  /** Optional bibliographic metadata surfaced to the LLM as a preamble. */
  title?: string;
  author?: string;
}

export async function extractDocumentGraph(
  params: ExtractDocumentGraphParams,
): Promise<void> {
  const {
    db,
    userId,
    sourceId,
    externalId,
    content,
    timestamp,
    logLabel,
    title,
    author,
  } = params;

  const linkedNodeId = await ensureSourceNode({
    db,
    userId,
    sourceId,
    timestamp,
    nodeType: NodeTypeEnum.enum.Document,
  });

  await runChunkedExtraction({
    userId,
    sourceType: "document",
    sourceId,
    statedAt: timestamp,
    linkedNodeId,
    sourceRefs: [{ externalId, sourceId, statedAt: timestamp }],
    content,
    logLabel,
    documentMetadata: {
      ...(title !== undefined && { title }),
      ...(author !== undefined && { author }),
    },
  });
}
