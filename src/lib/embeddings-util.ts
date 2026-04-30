import { generateEmbeddings } from "./embeddings";
import { DrizzleDB } from "~/db";
import { nodeEmbeddings, claimEmbeddings } from "~/db/schema";
import { claimEmbeddingText } from "~/lib/claim";
import type { ClaimStatus, Predicate } from "~/types/graph";
import { TypeId } from "~/types/typeid";
import { shouldSkipEmbeddingPersistence } from "~/utils/test-overrides";

export interface EmbeddableNode {
  id: TypeId<"node">;
  label: string;
  description?: string | null | undefined;
}

export interface EmbeddableClaim {
  claimId: TypeId<"claim">;
  predicate: Predicate;
  statement: string;
  status: ClaimStatus;
  statedAt: Date;
}

/**
 * Given an array of nodes with label/description, generates and inserts embeddings for each.
 * Throws if the number of returned embeddings does not match input length.
 * Skips nodes with missing label.
 */
export async function generateAndInsertNodeEmbeddings(
  db: DrizzleDB,
  nodes: EmbeddableNode[],
) {
  if (shouldSkipEmbeddingPersistence()) return;
  const validNodes = nodes.filter((n) => n.label && n.label.trim().length > 0);
  if (validNodes.length === 0) return;

  const embeddingInputs = validNodes.map(
    (n) => `${n.label}: ${n.description ?? ""}`,
  );

  const embeddings = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: embeddingInputs,
    truncate: true,
  });

  if (embeddings.data.length !== validNodes.length) {
    throw new Error("Failed to generate embeddings for all nodes");
  }

  for (let i = 0; i < validNodes.length; i++) {
    const embedding = embeddings.data[i]?.embedding;
    if (!embedding) {
      console.warn(`No embedding generated for node: ${validNodes[i]!.label}`);
      continue;
    }
    await db.insert(nodeEmbeddings).values({
      nodeId: validNodes[i]!.id,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }
}

/**
 * Given an array of claims, generates and inserts embeddings for each.
 */
export async function generateAndInsertClaimEmbeddings(
  db: DrizzleDB,
  claims: EmbeddableClaim[],
) {
  if (shouldSkipEmbeddingPersistence()) return;
  if (claims.length === 0) return;

  const embeddingInputs = claims.map((claim) =>
    claimEmbeddingText({
      predicate: claim.predicate,
      statement: claim.statement,
      status: claim.status,
      statedAt: claim.statedAt,
    }),
  );

  const embeddings = await generateEmbeddings({
    model: "jina-embeddings-v3",
    task: "retrieval.passage",
    input: embeddingInputs,
    truncate: true,
  });

  if (embeddings.data.length !== claims.length) {
    throw new Error("Failed to generate embeddings for all claims");
  }

  for (let i = 0; i < claims.length; i++) {
    const embedding = embeddings.data[i]?.embedding;
    if (!embedding) {
      console.warn(
        `No embedding generated for claim: ${claims[i]!.claimId} (${claims[i]!.predicate})`,
      );
      continue;
    }
    await db.insert(claimEmbeddings).values({
      claimId: claims[i]!.claimId,
      embedding,
      modelName: "jina-embeddings-v3",
    });
  }
}
