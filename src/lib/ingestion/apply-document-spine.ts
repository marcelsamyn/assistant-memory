/**
 * Fold a document's spine into the single source node instead of materializing
 * separate Concept nodes.
 *
 * The `Document` node that `ensureSourceNode` creates is the natural hub for a
 * source: every extracted entity is already `sourceLink`ed to the same source,
 * and retrieval renders a node's description as its summary. So rather than
 * minting 1-5 abstract spine `Concept` nodes (noise + cross-document
 * duplication risk) and "X is a central theme" RELATED_TO claims, we write the
 * spine — thesis + key themes — onto the source node's own label/description.
 * The retriever then gets one findable overview node wired (via sourceLinks)
 * to all of the document's entities.
 *
 * Best-effort: a failure here must never break ingestion (mirrors the spine
 * pre-pass itself). The thesis is still fed into each chunk's prompt separately
 * so the per-fragment extractor keeps the document-wide view.
 *
 * Common aliases: source node spine, document hub description, spine to
 * document node, folded spine.
 */
import { useDatabase } from "../../utils/db";
import { generateAndInsertNodeEmbeddings } from "../embeddings-util";
import { normalizeLabel } from "../label";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "~/db";
import { nodeEmbeddings, nodeMetadata, nodes, sourceLinks } from "~/db/schema";
import { withSourceWriteFence } from "~/lib/partition-access";
import { type DocumentSpine } from "~/lib/schemas/document-spine";
import { type TypeId } from "~/types/typeid";

/** Render a spine as a node description: thesis followed by the key themes. */
export function formatSpineDescription(spine: DocumentSpine): string {
  const themes = spine.spineConcepts.map((c) => c.label).join("; ");
  return themes.length > 0
    ? `${spine.thesis}\n\nKey themes: ${themes}`
    : spine.thesis;
}

/** Update a linked Document node when only caller-supplied title metadata changed. */
export async function updateDocumentTitle(params: {
  db: DrizzleDB;
  userId: string;
  sourceId: TypeId<"source">;
  expectedSourceVersion: number;
  title: string;
}): Promise<void> {
  const label = params.title.trim();
  if (label.length === 0) return;
  const canonicalLabel = normalizeLabel(label);
  await withSourceWriteFence(
    params.db,
    {
      userId: params.userId,
      sources: [
        {
          sourceId: params.sourceId,
          expectedSourceVersion: params.expectedSourceVersion,
        },
      ],
    },
    async (tx) => {
      const linked = await tx
        .select({
          nodeId: sourceLinks.nodeId,
          label: nodeMetadata.label,
          description: nodeMetadata.description,
        })
        .from(sourceLinks)
        .innerJoin(nodes, eq(nodes.id, sourceLinks.nodeId))
        .innerJoin(nodeMetadata, eq(nodeMetadata.nodeId, nodes.id))
        .where(
          and(
            eq(sourceLinks.sourceId, params.sourceId),
            eq(nodes.userId, params.userId),
            eq(nodes.nodeType, "Document"),
          ),
        )
        .limit(1);
      const document = linked[0];
      if (!document || document.label === label) return;
      const { nodeId, description } = document;
      await tx
        .update(nodeMetadata)
        .set({ label, canonicalLabel })
        .where(eq(nodeMetadata.nodeId, nodeId));
      await tx.delete(nodeEmbeddings).where(eq(nodeEmbeddings.nodeId, nodeId));
      await generateAndInsertNodeEmbeddings(tx, [
        { id: nodeId, label, description },
      ]);
    },
  );
}

/**
 * Upsert the source node's metadata so its label is the document title and its
 * description is the spine. Idempotent via the `node_metadata` unique-on-nodeId
 * constraint, so re-ingestion refreshes rather than duplicates.
 */
export async function applyDocumentSpine(params: {
  userId: string;
  sourceId: TypeId<"source">;
  expectedSourceVersion?: number;
  documentNodeId: TypeId<"node">;
  title: string | undefined;
  logLabel: string;
  spine: DocumentSpine;
}): Promise<void> {
  const {
    userId,
    sourceId,
    expectedSourceVersion,
    documentNodeId,
    title,
    logLabel,
    spine,
  } = params;
  const db = await useDatabase();

  const rawLabel = (title ?? logLabel).trim();
  const label = rawLabel.length > 0 ? rawLabel : null;
  const canonicalLabel = label ? normalizeLabel(label) : null;
  const description = formatSpineDescription(spine);

  await withSourceWriteFence(
    db,
    {
      userId,
      sources: [
        {
          sourceId,
          ...(expectedSourceVersion !== undefined
            ? { expectedSourceVersion }
            : {}),
        },
      ],
    },
    (tx) =>
      tx
        .insert(nodeMetadata)
        .values({
          nodeId: documentNodeId,
          label,
          canonicalLabel,
          description,
          additionalData: {},
        })
        .onConflictDoUpdate({
          target: nodeMetadata.nodeId,
          set: { label, canonicalLabel, description },
        }),
  );
}
