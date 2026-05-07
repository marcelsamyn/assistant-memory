/**
 * Materialize a document's spine concepts as Concept nodes before chunked
 * extraction runs. Each concept goes through the same identity-resolution
 * path the chunked extractor uses, so a spine concept that already exists
 * in the user's graph (e.g., a previously ingested book on the same theme)
 * is reused instead of being duplicated.
 *
 * Each spine node is sourceLinked to the current source so it shows up in
 * "nodes for this document" listings. The spine→document RELATED_TO claims
 * are inserted by `linkSpineToDocument` AFTER the chunked extraction loop
 * completes — inserting them earlier would have them wiped by the chunk-0
 * source-scoped claim replacement.
 */
import { useDatabase } from "../../utils/db";
import { resolveIdentity } from "../identity-resolution";
import { normalizeLabel } from "../label";
import { eq } from "drizzle-orm";
import {
  claims as claimsTable,
  nodeMetadata,
  nodes,
  sourceLinks,
  sources,
} from "~/db/schema";
import { type DocumentSpine } from "~/lib/schemas/document-spine";
import { NodeTypeEnum, type Scope } from "~/types/graph";
import { newTypeId } from "~/types/typeid";
import { type TypeId } from "~/types/typeid";

export interface SpineNode {
  nodeId: TypeId<"node">;
  label: string;
  description: string | null;
}

export async function ensureSpineNodes(params: {
  userId: string;
  sourceId: TypeId<"source">;
  spine: DocumentSpine;
}): Promise<SpineNode[]> {
  const { userId, sourceId, spine } = params;
  const db = await useDatabase();

  const scope = await _fetchSourceScope(sourceId, userId);
  const result: SpineNode[] = [];
  const localByCanonical = new Map<string, TypeId<"node">>();

  for (const concept of spine.spineConcepts) {
    const canonical = normalizeLabel(concept.label);
    if (canonical.length === 0) continue;

    const localHit = localByCanonical.get(canonical);
    if (localHit) {
      result.push({
        nodeId: localHit,
        label: concept.label,
        description: concept.description,
      });
      continue;
    }

    const resolution = await resolveIdentity({
      userId,
      candidate: {
        proposedLabel: concept.label,
        normalizedLabel: canonical,
        nodeType: NodeTypeEnum.enum.Concept,
        scope,
      },
    });

    let nodeId: TypeId<"node">;
    let description: string | null;
    if (resolution.resolvedNodeId) {
      nodeId = resolution.resolvedNodeId;
      // Reuse the existing description rather than overwriting with the
      // pre-pass version: the existing one came from prior context that may
      // be richer than this document's framing.
      const [existing] = await db
        .select({ description: nodeMetadata.description })
        .from(nodeMetadata)
        .where(eq(nodeMetadata.nodeId, nodeId))
        .limit(1);
      description = existing?.description ?? concept.description;
    } else {
      const [insertedNode] = await db
        .insert(nodes)
        .values({ userId, nodeType: NodeTypeEnum.enum.Concept })
        .returning();
      if (!insertedNode) {
        console.warn(
          `ensure-spine-nodes: failed to insert concept "${concept.label}"`,
        );
        continue;
      }
      nodeId = insertedNode.id;
      description = concept.description;
      await db.insert(nodeMetadata).values({
        nodeId,
        label: concept.label,
        canonicalLabel: canonical,
        description,
        additionalData: {},
      });
    }

    // Always link the spine node to this source — even when reused — so the
    // document's "extracted nodes" listing includes the spine concept.
    await db
      .insert(sourceLinks)
      .values({ sourceId, nodeId })
      .onConflictDoNothing();

    localByCanonical.set(canonical, nodeId);
    result.push({ nodeId, label: concept.label, description });
  }

  return result;
}

/**
 * Insert a `RELATED_TO` claim from each spine concept to the document node.
 * Run AFTER the chunked extraction loop; the chunk-0 source-scoped claim
 * replacement would otherwise wipe these claims before the document survives
 * its first chunk.
 */
export async function linkSpineToDocument(params: {
  userId: string;
  sourceId: TypeId<"source">;
  documentNodeId: TypeId<"node">;
  statedAt: Date;
  spineNodes: SpineNode[];
  documentLabel: string;
}): Promise<void> {
  const { userId, sourceId, documentNodeId, statedAt, spineNodes } = params;
  if (spineNodes.length === 0) return;

  const db = await useDatabase();
  const scope = await _fetchSourceScope(sourceId, userId);

  const rows = spineNodes.map((spine) => ({
    id: newTypeId("claim"),
    userId,
    subjectNodeId: spine.nodeId,
    objectNodeId: documentNodeId,
    predicate: "RELATED_TO" as const,
    statement: `"${spine.label}" is a central theme of "${params.documentLabel}".`,
    description: null,
    sourceId,
    scope,
    assertedByKind: "document_author" as const,
    statedAt,
    status: "active" as const,
  }));

  await db.insert(claimsTable).values(rows).onConflictDoNothing();
}

async function _fetchSourceScope(
  sourceId: TypeId<"source">,
  userId: string,
): Promise<Scope> {
  const db = await useDatabase();
  const [row] = await db
    .select({ scope: sources.scope })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  if (!row) {
    console.warn(
      `ensure-spine-nodes: source ${sourceId} not found for user ${userId}; defaulting to personal scope`,
    );
    return "personal";
  }
  return row.scope;
}
